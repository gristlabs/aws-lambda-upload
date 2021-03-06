"use strict";

import * as AWS from "aws-sdk";
import {fromCallback} from "bluebird";
import * as childProcess from "child_process";
import {main as collectJsDeps} from "collect-js-deps";
import * as commander from "commander";
import {createHash} from "crypto";
import * as fse from "fs-extra";
import * as path from "path";
import * as tmp from "tmp";
import {yamlParse} from "yaml-cfn";

tmp.setGracefulCleanup();

const defaultBucket = "aws-lambda-upload";

export interface ILogger {
  info(message?: string, ...optionalParams: any[]): void;
  debug(message?: string, ...optionalParams: any[]): void;
}

export interface ICollectOpts {
  browserifyArgs?: string[];  // Arguments to pass to collect-js-deps.
  logger?: ILogger;
  tsconfig?: string;          // Name of typescript config file, in order to support typescript
  nodePath?: string;          // Value for NODE_PATH environment variable for collect-js-deps.

  // Optional cache to reuse collect results. This is useful e.g. when processing a cloudformation
  // template which refers to the same startPath more than once.
  cache?: ZipFileCache;
}

const dfltLogger: ILogger = getLogger(true);

function getLogger(verbose: boolean): ILogger {
  return {
    info: console.info.bind(console),
    debug: verbose ? console.log.bind(console) : (() => {/* noop */}),
  };
}

/**
 * Run a command, returning a promise resolved on success. Similar to promisified
 * child_process.execFile(), but allows overriding options.stdio, and defaults them to 'inherit'
 * (to display the command's output).
 */
export function spawn(command: string, args: string[], options: any = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = childProcess.spawn(command, args, Object.assign({stdio: "inherit"}, options));
    c.on("error", (err: Error) => reject(err));
    c.on("exit", (code: number) => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

export type ZipFileCache = Map<string, string>;

/**
 * Walk topDir directory recursively, calling cb(path, stat) for each entry found.
 * If cb() return a promise, it will be waited on before proceeding.
 * Visits the tree in lexocographical order, and visits directories before their children.
 */
export async function fsWalk(topDir: string, cb: (fpath: string, stat: fse.Stats) => void): Promise<void> {
  const todo: Array<[string, fse.Stats]> = [[topDir, await fse.stat(topDir)]];
  while (todo.length > 0) {
    const [fpath, st] = todo.pop()!;
    await cb(fpath, st);
    if (st.isDirectory()) {
      const entries = await fse.readdir(fpath);
      entries.sort().reverse();     // Reverse, so that pop yields entries in sorted order.
      const paths = entries.map((e) => path.join(fpath, e));
      const stats = await Promise.all(paths.map((p) => fse.stat(p)));
      todo.push(...paths.map((p, i): [string, fse.Stats] => [p, stats[i]]));
    }
  }
}

/**
 * Collect and package code starting at the given path, into a temporary zip file.
 * @return {Promise<string>} Path to the zip file. It will be deleted on process exit.
 */
async function _makeTmpZipFile(startPath: string, options: ICollectOpts): Promise<string> {
  const logger = options.logger || dfltLogger;
  // Use memoized result if we are given a cache which has it.
  if (options.cache && options.cache.has(startPath)) {
    logger.debug(`Reusing cached zip file for ${startPath}`);
    return options.cache.get(startPath)!;
  }
  const args = options.browserifyArgs || [];
  if (options.tsconfig) {
    args.push("-p", "[", require.resolve("tsify"), "-p", options.tsconfig, "]");
  }

  const prevNodePath = process.env.NODE_PATH;
  const stageDir = await fromCallback((cb) =>
    tmp.dir({prefix: "aws-lambda-", unsafeCleanup: true}, cb));

  try {
    logger.debug(`Collecting files from ${startPath} in ${stageDir}`);
    if (options.nodePath !== undefined) {
      process.env.NODE_PATH = options.nodePath;
    }
    await collectJsDeps(["--outdir", stageDir, ...args, startPath]);

    // TODO Test what happens when startPath is absolute, and when dirname IS in fact "."
    if (path.dirname(startPath) !== ".") {
      // If startPath is not at top-level, create a helper top-level alias for it, since Lambdas
      // require the entry file to be top-level. (We can't solve this by moving files around as that
      // would break relative imports.)
      // Force startPath's extension to .js (e.g. if it's being compiled from TypeScript).
      const start = path.parse(startPath);
      const stubPath = path.join(stageDir, start.name + ".js");
      const requirePath = path.relative("", path.join(start.dir, start.name));
      await fse.writeFile(stubPath, `module.exports = require("./${requirePath}");\n`);
    }

    // Set all timestamps to a constant value (0) for all files, to produce consistent zip files
    // that are identical for identical data. Otherwise timestamps cause zip files to never match.
    await fsWalk(stageDir, (fpath, st) => fse.utimes(fpath, st.atime.getTime() / 1000, 0));

    // We use file() followed by remove(), rather than tmpName(), so that tmp module remembers to
    // clean it up on exit.
    const zipPath = await fromCallback((cb) =>
      tmp.file({prefix: "aws-lambda-", postfix: ".zip"}, cb));

    // We the destination zip must not exist.
    await fse.remove(zipPath);
    await spawn("zip", ["-q", "-r", "-X", zipPath, "."], {cwd: stageDir});

    if (options.cache) {
      options.cache.set(startPath, zipPath);
    }
    return zipPath;

  } finally {
    process.env.NODE_PATH = prevNodePath;
    fse.remove(stageDir);
  }
}

/**
 * Collect and package lambda code starting at the entry file startPath, to a local zip file at
 * outputZipPath. Will overwrite the destination if it exists. Returns outputZipPath.
 */
export async function packageZipLocal(startPath: string, outputZipPath: string, options: ICollectOpts = {}) {
  const logger = options.logger || dfltLogger;
  logger.info(`Packaging ${startPath} to local zip file ${outputZipPath}`);
  const tmpPath = await _makeTmpZipFile(startPath, options);
  await fse.copy(tmpPath, outputZipPath);
  logger.info(`Created ${outputZipPath}`);
  return outputZipPath;
}

export interface IS3Opts extends ICollectOpts {
  region?: string;          // Region to use, overriding config/env settings.
  s3Bucket?: string;        // S3 bucket to which to upload (default "aws-lambda-upload")
  s3Prefix?: string;        // Prefix (folder) added to uploaded zip files (default "")
  s3EndpointUrl?: string;   // Override S3 endpoint url.
}

export interface IS3Location {
  bucket: string;
  key: string;
}

/**
 * Collect and package lambda code and upload it to S3.
 * @return Promise for the object {bucket, key} describing the location of the uploaded file.
 */
export async function packageZipS3(startPath: string, options: IS3Opts = {}): Promise<IS3Location> {
  const logger = options.logger || dfltLogger;
  const s3Bucket = options.s3Bucket || defaultBucket;
  const s3Prefix = options.s3Prefix || "";
  logger.info(`Packaging ${startPath} for ${options.region} s3://${s3Bucket}/${s3Prefix}...`);
  const s3 = new AWS.S3({
    region: options.region,
    endpoint: options.s3EndpointUrl,
    // Fixes a bug when using a custom endpoint for localstack. For more info, see:
    // https://github.com/localstack/localstack/issues/43
    s3ForcePathStyle: true,
  });

  // Check S3 bucket, and create if needed.
  try {
    await s3.headBucket({Bucket: s3Bucket}).promise();
    logger.debug(`Bucket s3://${s3Bucket} exists`);
  } catch (err) {
    if (err.code === "Forbidden") {
      throw new Error(`Can't read s3://${s3Bucket}: grant AWS permissions or change --s3-bucket`);
    }
    if (err.code !== "NotFound") {
      throw err;
    }
    logger.info(`Bucket s3://${s3Bucket} missing; creating`);
    await s3.createBucket({Bucket: s3Bucket}).promise();
  }

  const tmpPath = await _makeTmpZipFile(startPath, options);
  const zipData = await fse.readFile(tmpPath);

  // Get S3 key using s3Prefix + md5 of contents (that's what `aws cloudformation package` does).
  const checksumBuf = createHash("md5").update(zipData).digest();
  const checksumHex = checksumBuf.toString("hex");
  const checksumB64 = checksumBuf.toString("base64");
  const prefix = s3Prefix && !s3Prefix.endsWith("/") ? s3Prefix + "/" : (s3Prefix || "");
  const key = `${prefix}${checksumHex}.zip`;
  logger.debug(`Uploading zipped data to s3://${s3Bucket}/${key}`);

  // Skip upload if the object exists (since md5 checksum in key implies the same content).
  const {Contents} = await s3.listObjectsV2({Bucket: s3Bucket, MaxKeys: 1, Prefix: key}).promise();
  const exists = (Contents && Contents.length > 0 && Contents[0].Key === key);
  if (exists) {
    logger.info(`s3://${s3Bucket}/${key} already exists, skipping upload`);
  } else {
    // Do the upload to S3.
    await s3.upload({ Body: zipData, Bucket: s3Bucket, Key: key, ContentMD5: checksumB64 }).promise();
    logger.info(`s3://${s3Bucket}/${key} uploaded`);
  }
  return { bucket: s3Bucket, key };
}

export interface ILambdaOpts extends ICollectOpts {
  region?: string;              // Region to use, overriding config/env settings.
  lambdaEndpointUrl?: string;   // Override Lambda endpoint url.
}

/**
 * Collect lambda code, and use it to update AWS Lambda function of the given name.
 * @return {Object} Promise for the response as returned by AWS Lambda UpdateFunctionCode.
 *  See http://docs.aws.amazon.com/lambda/latest/dg/API_UpdateFunctionCode.html
 */
export async function updateLambda(startPath: string, lambdaName: string,
                                   options: ILambdaOpts = {}): Promise<any> {
  const logger = options.logger || dfltLogger;
  logger.info(`Packaging ${startPath} to update lambda ${lambdaName}`);
  const lambda = new AWS.Lambda({
    region: options.region,
    endpoint: options.lambdaEndpointUrl,
  });
  const tmpPath = await _makeTmpZipFile(startPath, options);
  const zipData = await fse.readFile(tmpPath);
  const resp = await lambda.updateFunctionCode({FunctionName: lambdaName, ZipFile: zipData}).promise();
  logger.info(`Updated lambda ${lambdaName} version ${resp.Version} ` +
    `(${resp.CodeSize} bytes) at ${resp.LastModified}`);
  return resp;
}

function parseTemplate(text: string, ext: string): any {
  try { return JSON.parse(text); } catch (e1) {
    if (ext === "json") {
      throw new Error(`Unable to parse JSON template: ${e1}`);
    }
    try { return yamlParse(text); } catch (e2) {
      throw new Error(`Unable to parse YAML template: ${e2}`);
    }
  }
}

/**
 * Parse the CloudFormation template at the given path (must be in JSON or YAML format), package
 * any code mentioned in it to S3, replace template references with S3 locations, and return the
 * adjusted template object.
 *
 * It is similar to `aws cloudformation package` command. It recognizes these template keys:
 *
 *  - `Code` property in `Resource` with `Type: AWS::Lambda::Function`.
 *  - `CodeUri` property in `Resource` with `Type: AWS::Serverless::Function`.
 *
 * When these contain a file path, it'll be interpreted as a JS entry file, packaged using
 * `packageZipS3()`, and replaced in the output template with appropriate S3 info. The path may be
 * relative to the directory containing templatePath.
 *
 * @param templatePath: Path to the JSON or YAML template file.
 * @return The template object, with certain entries replaced with S3 locations.
 */
export async function cloudformationPackage(templatePath: string, options: IS3Opts = {}): Promise<any> {
  const logger = options.logger || dfltLogger;
  logger.info(`Processing template ${templatePath}`);
  const templateText = await fse.readFile(templatePath, "utf8");
  const template: any = parseTemplate(templateText, path.extname(templatePath));
  if (!options.cache) {
    options = Object.assign({ cache: new Map<string, string>() }, options);
  }

  // Helper function to process a single property in the template file.
  async function resolveCfnPath(key: string, resource: any, prop: string,
                                converter: (obj: IS3Location) => any) {
    if (!resource.Properties) {
      logger.debug(`Template resource ${key} has no properties; skipping`);
      return;
    }
    const cfnValue = resource.Properties[prop];
    if (typeof cfnValue !== "string" || /^(s3|https?):\/\//.test(cfnValue)) {
      logger.debug(`Template property ${prop} of ${key} is not a path; skipping`);
      return;
    }
    const cfnPath = path.resolve(path.dirname(templatePath), cfnValue);
    if (!await fse.pathExists(cfnPath)) {
      logger.info(`Template property ${prop} of ${key}: ${cfnPath} does not exist; skipping`);
      return;
    }
    const s3Info = await packageZipS3(cfnPath, options);
    resource.Properties[prop] = converter(s3Info);
    logger.info(`Template property ${prop} of ${key} updated`);
  }

  for (const key of Object.keys(template.Resources)) {
    const res = template.Resources[key];
    if (res.Type === "AWS::Lambda::Function") {
      await resolveCfnPath(key, res, "Code",
        (obj: IS3Location) => ({S3Bucket: obj.bucket, S3Key: obj.key}));
    } else if (res.Type === "AWS::Serverless::Function") {
      await resolveCfnPath(key, res, "CodeUri",
        (obj: IS3Location) => `s3://${obj.bucket}/${obj.key}`);
    }
  }
  return template;
}

/**
 * As cloudformationPackage, but writes the adjusted template to the given output file as JSON.
 * See cloudformationPackage() for other parameters.
 * @param outputPath: Path to the JSON output file. May be "-" for stdout.
 * @return Promise that's resolved when the template has been written.
 */
export async function cloudformationPackageOutput(templatePath: string, outputPath: string, options: any) {
  const logger = options.logger || dfltLogger;
  const template = await cloudformationPackage(templatePath, options);
  const json = JSON.stringify(template, null, 2);
  logger.info(`Writing out process template to ${outputPath}`);
  if (outputPath === "-") {
    return fromCallback((cb) => process.stdout.write(json, "utf8", cb));
  } else {
    return fse.writeFile(outputPath, json);
  }
}

/**
 * Main entry point when used from the command line.
 */
export function main() {
  commander
  .description("Package node.js code for AWS lambda with its minimal dependencies.\n" +
    "  Extra arguments given after -- will be passed to browserify")
  .usage("[options] <start-file> -- [browserify-options]")
  .option("-l, --lambda <name>", "Name of lambda function to update")
  .option("--zip <output-path>", "Save the packaged lambda code to a local zip file")
  .option("--s3", "Save the packaged lambda code to S3, and print the S3 URI to stdout")
  .option("--cfn <output-path>", "Interpret <start-path> as a CloudFormation template\n" +
    "   (.json or .yml), and package lambda code mentioned there. Replaces code references\n" +
    "   with S3 locations, and outpus adjusted template to <output-path> ('-' for stdout)")
  .option("-r, --region <string>", "AWS region to use, for --lambda or --s3 flags")
  .option("--s3-bucket <string>", "S3 bucket to which to upload zip files " +
    `(default ${defaultBucket})`, defaultBucket)
  .option("--s3-prefix <string>", "Prefix (folder) added to zip files uploaded to S3", "")
  .option("--s3-endpoint-url <string>", "Override S3 endpoint url", (v) => new AWS.Endpoint(v))
  .option("-v, --verbose", "Produce verbose output")
  .option("--tsconfig <path>", "If given, support TypeScript, and use the given\n" +
    "   config file, or directory containing tsconfig.json");

  const {args, unknown} = commander.parseOptions(process.argv.slice(2));
  const opts = commander.opts();
  if (args.length === 0 || unknown.length > 0 || !(opts.lambda || opts.zip || opts.s3 || opts.cfn)) {
    commander.outputHelp();
    if (unknown.length > 0) {
      process.stdout.write(`\nUnknown option(s) ${unknown.join(", ")}\n`);
    }
    return;
  }

  const startFile = args[0];
  const browserifyArgs = args.slice(1);
  const logger: ILogger = getLogger(commander.verbose);
  const cache = new Map<string, string>();

  return dispatchWork(startFile, Object.assign(opts, {browserifyArgs, logger, cache}))
  .catch((err) => {
    logger.info("Error", err.message);
    process.exit(1);
  });
}

async function dispatchWork(startFile: string, options: any) {
  if (options.cfn) {
    await cloudformationPackageOutput(startFile, options.cfn, options);
    // Interprets startFile differently, so doesn't make sense to combine with other options.
    return;
  }
  if (options.zip) { await packageZipLocal(startFile, options.zip, options); }
  if (options.s3) { await packageZipS3(startFile, options); }
  if (options.lambda) { await updateLambda(startFile, options.lambda, options); }
}
