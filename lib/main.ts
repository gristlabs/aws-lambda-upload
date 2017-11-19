"use strict";

import * as AWS from "aws-sdk";
import * as bluebird from "bluebird";
import * as childProcess from "child_process";
import {main as collectJsDeps} from "collect-js-deps";
import * as commander from "commander";
import {createHash} from "crypto";
import * as fse from "fs-extra";
import * as path from "path";
import * as tmp from "tmp";
import {yamlParse} from "yaml-cfn";

bluebird.promisifyAll(childProcess);
bluebird.promisifyAll(tmp);
bluebird.config({longStackTraces: true});

tmp.setGracefulCleanup();

const zipFiles = new Map();

/**
 * Collect and package code starting at the given path, into a temporary zip file.
 * @return {Promise<string>} Path to the zip file. It will be deleted on process exit.
 */
async function _makeTmpZipFile(startPath: string, browserifyArgs: string[]): Promise<string> {
  // Use memoized result. This is useful when processing a cloudformation template which refers to
  // the same startPath more than once.
  // TODO: test that it works.
  if (zipFiles.has(startPath)) {
    return zipFiles.get(startPath);
  }

  const stageDir = await bluebird.fromCallback((cb) => tmp.dir({unsafeCleanup: true}, cb));
  try {
    const zipPath = await bluebird.fromCallback((cb) => tmp.file(
      {prefix: "aws-lambda", postfix: ".zip", discardDescriptor: true}, cb));
    await collectJsDeps(["--outdir", stageDir, ...browserifyArgs]);

    // TODO Test what happens when startPath is absolute, and when dirname IS in fact "."
    if (path.dirname(startPath) !== ".") {
      // If startPath is not at top-level, create a helper top-level alias for it, since Lambdas
      // require the entry file to be top-level. (We can't solve this by moving files around as that
      // would break relative imports.)
      const stubPath = path.join(stageDir, path.basename(startPath));
      await fse.writeFile(stubPath, `module.exports = require("${startPath}");\b`);
    }
    const stdout = await bluebird.fromCallback((cb) =>
      childProcess.execFile("zip", ["-q", zipPath, "."], {cwd: stageDir}, cb));
    // tslint:disable-next-line:no-console TODO
    console.log("ZIP OUTPUT", stdout);
    zipFiles.set(startPath, zipPath);
    return zipPath;

  } finally {
    fse.remove(stageDir);
  }
}

interface ILogger {
  info(message?: string, ...optionalParams: any[]): void;
  debug(message?: string, ...optionalParams: any[]): void;
}

interface ICollectOpts {
  browserifyArgs: string[];   // Arguments to pass to collect-js-deps.
  logger: ILogger;
}

/**
 * Collect and package lambda code starting at the entry file startPath, to a local zip file at
 * outputZipPath. Will overwrite the destination if it exists. Returns outputZipPath.
 */
export async function packageZipLocal(startPath: string, outputZipPath: string, options: ICollectOpts) {
  options.logger.info(`Packaging ${startPath} to local zip file ${outputZipPath}`);
  const tmpPath = await _makeTmpZipFile(startPath, options.browserifyArgs);
  await fse.copy(tmpPath, outputZipPath);
  options.logger.info(`Created ${outputZipPath}`);
  return outputZipPath;
}

interface IS3Opts extends ICollectOpts {
  region?: string;          // Region to use, overriding config/env settings.
  s3Bucket?: string;        // S3 bucket to which to upload (default "aws-lambda-upload")
  s3Prefix?: string;        // Prefix (folder) added to uploaded zip files (default "")
  s3EndpointUrl?: string;   // Override S3 endpoint url.
}

interface IS3Location {
  bucket: string;
  key: string;
}

/**
 * Collect and package lambda code and upload it to S3.
 * @return Promise for the object {bucket, key} describing the location of the uploaded file.
 */
export async function packageZipS3(startPath: string, options: IS3Opts): Promise<IS3Location> {
  const s3Bucket = options.s3Bucket || "aws-lambda-upload";
  const s3Prefix = options.s3Prefix || "";
  options.logger.info(`Packaging ${startPath} for ${options.region} s3://${s3Bucket}/${s3Prefix}...`);
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
    options.logger.debug(`Bucket s3://${s3Bucket} exists`);
  } catch (err) {
    if (err.code === "Forbidden") {
      throw new Error(`Can't read s3://${s3Bucket}: grant AWS permissions or change --s3-bucket`);
    }
    if (err.code !== "NotFound") {
      throw err;
    }
    options.logger.info(`Bucket s3://${s3Bucket} missing; creating`);
    await s3.createBucket({Bucket: s3Bucket}).promise();
  }

  const tmpPath = await _makeTmpZipFile(startPath, options.browserifyArgs);
  const zipData = await fse.readFile(tmpPath);

  // Get S3 key using s3Prefix + md5 of contents (that's what `aws cloudformation package` does).
  const checksumBuf = createHash("md5").update(zipData).digest();
  const checksumHex = checksumBuf.toString("hex");
  const checksumB64 = checksumBuf.toString("base64");
  const key = s3Prefix ? `${s3Prefix}/${checksumHex}` : checksumHex;
  options.logger.debug(`Uploading zipped data to s3://${s3Bucket}/${key}`);

  // Skip upload if the object exists (since md5 checksum in key implies the same content).
  try {
    await s3.headObject({Bucket: s3Bucket, Key: key}).promise();
    options.logger.info(`s3://${s3Bucket}/${key} already exists, skipping upload`);
  } catch (err) {
    if (err.code !== "NotFound") { throw err; }
    // Do the upload to S3.
    await s3.upload({ Body: zipData, Bucket: s3Bucket, Key: key, ContentMD5: checksumB64 }).promise();
    options.logger.info(`s3://${s3Bucket}/${key} uploaded`);
  }
  return { bucket: s3Bucket, key };
}

interface ILambdaOpts extends ICollectOpts {
  region?: string;              // Region to use, overriding config/env settings.
  lambdaEndpointUrl?: string;   // Override Lambda endpoint url.
}

/**
 * Collect lambda code, and use it to update AWS Lambda function of the given name.
 * @return {Object} Promise for the response as returned by AWS Lambda UpdateFunctionCode.
 *  See http://docs.aws.amazon.com/lambda/latest/dg/API_UpdateFunctionCode.html
 */
export async function updateLambda(startPath: string, lambdaName: string, options: ILambdaOpts) {
  options.logger.info(`Packaging ${startPath} to update lambda ${lambdaName}`);
  const lambda = new AWS.Lambda({
    region: options.region,
    endpoint: options.lambdaEndpointUrl,
  });
  const tmpPath = await _makeTmpZipFile(startPath, options.browserifyArgs);
  const zipData = await fse.readFile(tmpPath);
  const resp = await lambda.updateFunctionCode(
    {FunctionName: lambdaName, ZipFile: zipData}).promise();
  options.logger.info(`Updated lambda ${lambdaName} version ${resp.Version} ` +
    `(${resp.CodeSize} bytes) at ${resp.LastModified}`);
  return resp;
}

interface ICfnOpts extends IS3Opts {
  cfnEndpointUrl?: string;  // Override CloudFormation endpoint url.
}

function parseTemplate(text: string): any {
  try { return JSON.parse(text); } catch (e1) {
    try { return yamlParse(text); } catch (e2) {
      throw new Error(`Unable to parse template: ${e2}`);
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
export async function cloudformationPackage(templatePath: string, options: ICfnOpts): Promise<any> {
  options.logger.info(`Processing template ${templatePath}`);
  const templateText = await fse.readFile(templatePath, "utf8");
  const template: any = parseTemplate(templateText);

  const promises: Array<Promise<void>> = [];
  Object.keys(template.Resources).forEach((key) => {
    const res = template.Resources[key];
    if (res.Type === "AWS::Lambda::Function") {
      promises.push(resolveCfnPath(key, res, "Code",
        (obj: IS3Location) => ({S3Bucket: obj.bucket, S3Key: obj.key})));
    } else if (res.Type === "AWS::Serverless::Function") {
      promises.push(resolveCfnPath(key, res, "CodeUri",
        (obj: IS3Location) => `s3://${obj.bucket}/${obj.key}`));
    }
  });

  // Helper function to process a single property in the template file.
  async function resolveCfnPath(key: string, resource: any, prop: string,
                                converter: (obj: IS3Location) => any) {
    const cfnValue = resource[prop];
    if (typeof cfnValue !== "string" || /^(s3|https?):\/\//.test(cfnValue)) {
      options.logger.debug(`Template property ${prop} of ${key} is not a path; skipping`);
      return;
    }
    const cfnPath = path.resolve(path.dirname(templatePath), cfnValue);
    if (!await fse.pathExists(cfnPath)) {
      options.logger.info(`Template property ${prop} of ${key}: ${cfnPath} does not exist; skipping`);
      return;
    }
    const s3Info = await packageZipS3(cfnPath, options);
    resource[prop] = converter(s3Info);
    options.logger.info(`Template property ${prop} of ${key} updated`);
  }

  await Promise.all(promises);
  return template;
}

/**
 * As cloudformationPackage, but writes the adjusted template to the given output file as JSON.
 * See cloudformationPackage() for other parameters.
 * @param outputPath: Path to the JSON output file. May be "-" for stdout.
 * @return Promise that's resolved when the template has been written.
 */
export async function cloudformationPackageOutput(templatePath: string, outputPath: string, options: any) {
  const template = await cloudformationPackage(templatePath, options);
  const json = JSON.stringify(template, null, 2);
  options.logger.info(`Writing out process template to ${outputPath}`);
  if (outputPath === "-") {
    return bluebird.fromCallback((cb) => process.stdout.write(json, "utf8", cb));
  } else {
    return fse.writeFile(outputPath, json);
  }
}

function getLogger(verbose: boolean): ILogger {
  return {
    info: console.info.bind(console),
    debug: verbose ? console.debug.bind(console) : (() => {/* noop */}),
  };
}

/**
 * Main entry point when used from the command line.
 */
export function main() {
  commander
  .description("Package node.js code for AWS lambda with its minimal dependencies.\n" +
    "Extra arguments given after -- will be passed to browserify")
  .usage("[options] -- [browserify-options] <start-file>")
  .option("--lambda, -l <name>", "Name of lambda function to update")
  .option("--zip <output-path>", "Save the packaged lambda code to a local zip file")
  .option("--s3", "Save the packaged lambda code to S3, and print the S3 URI to stdout")
  .option("--cfn <output-path>", "Interpret <start-path> as a CloudFormation template" +
    " (.json or .yml), and package lambda code mentioned there. Replaces code references" +
    " with S3 locations, and outpus adjusted template to <output-path> ('-' for stdout)")
  .option("--region, -r <string>", "AWS region to use, for --lambda or --s3 flags")
  .option("--s3-bucket <string>", "S3 bucket to which to upload zip files", "aws-lambda-upload")
  .option("--s3-prefix <string>", "Prefix (folder) added to zip files uploaded to S3", "")
  .option("--s3-endpoint-url <string>", "Override S3 endpoint url", (v) => new AWS.Endpoint(v))
  .option("--verbose, -v", "Produce verbose output")
  .option("--tsconfig <path>", "If given, support TypeScript, and use the given" +
    " config file, or directory containing tsconfig.json")
  .arguments("<start-file>")
  .parse(process.argv);

  const opts = commander.opts();
  const browserifyArgs = commander.args;
  const logger: ILogger = getLogger(commander.verbose);

  if (!(opts.lambda || opts.zip || opts.s3 || opts.cfn)) {
    commander.help();
    process.exit(1);
  } else {
    return dispatchWork(Object.assign(opts, {browserifyArgs, logger}))
    .catch((err) => {
      logger.info("Error", err.message);
      process.exit(1);
    });
  }
}

async function dispatchWork(options: any) {
  if (options.cfn) {
    await cloudformationPackageOutput(options.start_file, options.cfn, options);
    // Interprets start_file differently, so doesn't make sense to combine with other options.
    return;
  }
  if (options.zip) { await packageZipLocal(options.startFile, options.zip, options); }
  if (options.s3) { await packageZipS3(options.startFile, options); }
  if (options.lambda) { await updateLambda(options.startFile, options.lambda, options); }
}
