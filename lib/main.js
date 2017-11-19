"use strict";

const crypto = require('crypto');
const path = require('path');
const bluebird = require('bluebird');
const fse = require('fs-extra');
const child_process = bluebird.promisifyAll(require('child_process'));
const browserify = require('browserify');
const commander = require('commander');
const through = require('through2');
const tmp = bluebird.promisifyAll(require('tmp'));
const AWS = require('aws-sdk');
const tsify = require('tsify');
const {yamlParse} = require('yaml-cfn');


bluebird.config({longStackTraces: true});
tmp.setGracefulCleanup();


/**
 * Returns a Promise for a Boolean for whether or not path `p` exists.
 */
function existsAsync(p) {
  return fs.accessAsync(p).return(true).catch(() => false);
}

/**
 * Given a list of paths, returns all package.json files that may affect them (i.e. all
 * package.json files from any of their parent directories).
 */
function getPackageFiles(paths) {
  // Collect all parent directories of paths, and recursive parents.
  let dirs = new Set();
  paths.forEach(p => {
    let d;
    while ((d = path.dirname(p)) !== p) { dirs.add(d); p = d; }
  });

  // Skip the top-level directory, since we only care about package.json files for dependencies.
  dirs.delete('.');

  let pkgFiles = Array.from(dirs).map(d => d + '/package.json');
  return bluebird.filter(pkgFiles, existsAsync, { concurrency: 10 });
}
exports.getPackageFiles = getPackageFiles;


function replaceExt(fpath, newExt) {
  const oldExt = path.extname(fpath);
  return path.join(path.dirname(fpath), path.basename(fpath, oldExt) + newExt);
}

function stagePath(fpath, stageDir) {
  return path.join(stageDir, replaceExt(fpath, '.js'));
}

function saveTranslatedOutput(relPath, stageDir, source) {
  return bluebird.try(() => {
    if (path.extname(relPath) === '.js') {
      return relPath;
    }
    const newPath = stagePath(relPath, stageDir);
    return fs.outputFileAsync(newPath, source).return(newPath);
  });
}

/**
 * Given a startFile path, returns a Promise for an array of all dependencies to include in the
 * package, including any necessary package.json files.
 */
function collectDependencies(startFile, stageDir, options = {}) {
  var b = browserify({
      entries: [startFile],
      builtins: false,
      commondir: false,
      browserField: false,
      dedupe: true,
      ignoreMissing: options.ignoreMissing,
      debug: false,
      paths: options.paths,
  });

  if (options.tsconfig) {
    b.plugin(tsify, { project: options.tsconfig });
  }

  b.exclude('aws-sdk');

  let srcPaths = [], paths = [];
  b.pipeline.get('deps').push(through.obj((row, enc, next) => {
    let p = path.relative('', row.file || row.id);
    srcPaths.push(p);
    saveTranslatedOutput(p, stageDir, row.source)
    .then(n => { paths.push(n); next(); });
  }));

  return bluebird.fromCallback(cb => b.bundle(cb))
  .then(() => getPackageFiles(srcPaths))
  .then(pkgPaths => paths.concat(pkgPaths).sort());
}
exports.collectDependencies = collectDependencies;


/**
 * Runs a command and returns a Promise that's resolved if it's successful.
 */
function spawn(command, args, options) {
  return new bluebird((resolve, reject) => {
    let c = child_process.spawn(command, args, Object.assign({stdio: 'inherit'}, options || {}));
    c.on('error', err => reject(err));
    c.on('exit', code => {
      if (code !== 0) {
        reject(new Error(`Command failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}
exports.spawn = spawn;


function isSubPath(parent, subPath) {
  const rel = path.relative(parent, subPath);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function runWithChdir(dir, func) {
  let cwd = process.cwd();
  process.chdir(dir);
  return bluebird.try(func)
  .finally(() => process.chdir(cwd));
}

// TODO
// (1) comment all helper functions and code.
// (2) fix existing test cases for collectDependencies
// (3) add test case for translation
// (4) add test case for a fully-working zip/unzip/run flow.

/**
 * Packages and zips all dependencies of startFile into the given zip file. If the startFile is
 * not at top-level, creates a helper top-level alias for it with the same basename.
 *
 * @param {string} startFile: Path to the start file.
 * @param {string} zipFile: The name of the zip file to create. It will be overwritten if exists.
 * @returns {Promise} Promise that resolves on success.
 */
function packageLambda(startFile, zipFile, options) {
  let stageDir;
  return tmp.dirAsync({ unsafeCleanup: true })
  .then(_tmpDir => { stageDir = _tmpDir; })
  .then(() => collectDependencies(startFile, stageDir, options))
  .then(paths => {
    let origPaths = paths.filter(p => !isSubPath(stageDir, p));
    let newPaths = paths.filter(p => isSubPath(stageDir, p)).map(p => path.relative(stageDir, p));
    return fs.unlinkAsync(zipFile).catch(() => {})
    .then(() => spawn('zip', ['-q', zipFile].concat(origPaths)))
    .then(() => runWithChdir(stageDir,
      () => spawn('zip', ['-q', zipFile].concat(newPaths)))
    )
  })
  .then(() => {
    // If startFile is not at top-level, create a helper top-level alias for it, since Lambda
    // requires the entry file to be top-level, and moving files around in the archive would break
    // relative imports.
    if (path.dirname(startFile) !== '.') {
      return tmp.dirAsync({ unsafeCleanup: true })
      .then(tmpDir => {
        let entry = path.join(tmpDir, path.basename(startFile));
        return fs.writeFileAsync(entry, `module.exports = require('${startFile}');\n`)
        .then(() => spawn('zip', ['-q', '-j', zipFile, entry]));
      });
    }
  });
}
exports.packageLambda = packageLambda;


/**
 * Packages and upload startFile with all its dependencies function.
 * @param {string} startFile: Path to the start file.
 * @param {string} options.lambda: The name of the lambda. Defaults to basename of startFile.
 * @param {string} options.region: The region to use for AWS.
 * @returns {Promise} Promise that resolves to the return value of AWS.Lambda.updateFunctionCode.
 */
function uploadLambda(startFile, options) {
  let lambdaName = options.lambda || path.basename(startFile, '.js');
  let zipFile;

  return tmp.fileAsync({ prefix: 'aws-lambda', postfix: '.zip', discardDescriptor: true })
  .then(_zipFile => {
    zipFile = _zipFile;
    console.log(`Building '${startFile}' into '${zipFile}'`);
    return packageLambda(startFile, zipFile, options);
  })
  .then(() => {
    if (options.output) {
      console.log(`Moving ${zipFile} to ${options.output}`);
      return fs.renameAsync(zipFile, options.output);
    } else {
      console.log(`Upoading as lambda '${lambdaName}'`);
      return fs.readFileAsync(zipFile, {encoding: null})
      .then(zipContents => {
        var lambda = new AWS.Lambda({region: options.region});
        return lambda.updateFunctionCode({FunctionName: lambdaName, ZipFile: zipContents}).promise();
      })
      .tap(data =>
        console.log(`Uploaded ${data.FunctionName} ${data.Version} (${data.CodeSize} bytes)` +
          ` at ${data.LastModified}`)
      );
    }
  });
}
exports.uploadLambda = uploadLambda;

const collectJsDeps = require('collect-js-deps');

/**
 * Collect and package code starting at the given path, into a temporary zip file.
 * @return {Promise<string>} Path to the zip file. It will be deleted on process exit.
 */
function _makeTmpZipFile(startPath, browserifyArgs) {
  /*
  return tmp.fileAsync({ prefix: 'aws-lambda', postfix: '.zip', discardDescriptor: true })
  .then(_zipFile => {

  return
  collectJsDeps.main(['--outdir', tmpDir, ...browserifyArgs])
  .then(

  let stageDir;
  return tmp.dirAsync({ unsafeCleanup: true })
  .then(_tmpDir => { stageDir = _tmpDir; })
  .then(() => collectDependencies(startFile, stageDir, options))
  .then(paths => {
    let origPaths = paths.filter(p => !isSubPath(stageDir, p));
    let newPaths = paths.filter(p => isSubPath(stageDir, p)).map(p => path.relative(stageDir, p));
    return fs.unlinkAsync(zipFile).catch(() => {})
    .then(() => spawn('zip', ['-q', zipFile].concat(origPaths)))
    .then(() => runWithChdir(stageDir,
      () => spawn('zip', ['-q', zipFile].concat(newPaths)))
    )
  })
  .then(() => {
    // If startFile is not at top-level, create a helper top-level alias for it, since Lambda
    // requires the entry file to be top-level, and moving files around in the archive would break
    // relative imports.
    if (path.dirname(startFile) !== '.') {
      return tmp.dirAsync({ unsafeCleanup: true })
      .then(tmpDir => {
        let entry = path.join(tmpDir, path.basename(startFile));
        return fs.writeFileAsync(entry, `module.exports = require('${startFile}');\n`)
        .then(() => spawn('zip', ['-q', '-j', zipFile, entry]));
      });
    }
  });

function main(args) {
      reject(new Error('Usage: collect-js-deps --outdir <path> [--list] ' +
     */
}

/**
 * Collect and package lambda code to a local zip file at outputZipPath. Will overwrite
 * destination if it exists.
 * @param {string} startPath: Path the JS file that's the entry point to the lambda.
 * @param {string} outputZipPath: Path to the zip file to create. Will be overwritten.
 * @param {Array<string>} options.browserifyArgs: arguments to pass to collect-js-deps.
 * @return {Promise<string>} Promise for the path of the new zip file.
 */
function packageZipLocal(startPath, outputZipPath, options) {
  console.log(`Packaging ${startPath} to local zip file ${outputZipPath}`);
  return _makeTmpZipFile(startPath, options.browserifyArgs)
  .then(tmpPath =>
    fse.copy(tmpPath, outputZipPath)
    .then(() => console.log(`Created ${outputZipPath}`))
    .then(() => tmpPath)
  );
}

/**
 * Collect and package lambda code and upload it to S3.
 * @param {string} startPath: Path the JS file that's the entry point to the lambda.
 * @param {string} options.region: Region to use, overriding config/env settings.
 * @param {string} options.s3Bucket: S3 bucket to which to upload (default 'aws-lambda-upload')
 * @param {string} options.s3Prefix: Prefix (folder) added to uploaded zip files (default '')
 * @param {string} options.s3EndpointUrl: Override S3 endpoint url.
 * @param {Array<string>} options.browserifyArgs: arguments to pass to collect-js-deps.
 * @return {Promise<Object>} Promise for the object {Bucket, Key} describing the uploaded file.
 */
function packageZipS3(startPath, options) {
  const s3Bucket = options.s3Bucket || 'aws-lambda-upload';
  const s3Prefix = options.s3Prefix || '';
  console.log(`Packaging ${startPath} for ${options.region} s3://${s3Bucket}/${s3Prefix}...`);
  const s3 = new AWS.S3({
    region: options.region,
    endpoint: options.s3EndpointUrl,
    // Fixes a bug when using a custom endpoint for localstack. For more info, see:
    // https://github.com/localstack/localstack/issues/43
    s3ForcePathStyle: true
  });
  return Promise.resolve()
  .then(() => {
    // Check S3 bucket, and create if needed.
    return s3.headBucket({Bucket: s3Bucket}).promise()
    .catch(ifErrorCode('Forbidden'), err => {
      throw new Error(`Can't read s3://${s3Bucket}: grant AWS permissions or change --s3-bucket`);
    })
    .then(() => console.log(`Bucket s3://${s3Bucket} exists`))
    .catch(ifErrorCode('NotFound'), err => {
      console.log(`Bucket s3://${s3Bucket} missing; creating`);
      return s3.createBucket({Bucket: s3Bucket}).promise();
    });
  })
  .then(() => _makeTmpZipFile(startPath, options.browserifyArgs))
  .then(tmpPath => fse.readFile(tmpPath, {encoding: null}))
  .then(zipData => {
    // Get S3 key using s3Prefix + md5 of contents (that's what `aws cloudformation package` does).
    const checksumBuf = crypto.createHash('md5').update(zipData).digest();
    const checksumHex = checksumBuf.toString('hex');
    const checksumB64 = checksumBuf.toString('base64');
    const key = s3Prefix ? `${s3Prefix}/${checksumHex}` : checksumHex;
    console.log(`Uploading zipped data to s3://${s3Bucket}/${key}`);

    // Skip upload if the object exists (since md5 checksum in key implies the same content).
    return s3.headObject({Bucket: s3Bucket, Key: key}).promise()
    .then(() => console.log(`s3://${s3Bucket}/${key} already exists, skipping upload`))
    // Do the upload to S3.
    .catch(ifErrorCode('NotFound'), () =>
      s3.upload({ Body: zipData, Bucket: s3Bucket, Key: key, ContentMD5: checksumB64 }).promise()
      .then(() => console.log(`s3://${s3Bucket}/${key} uploaded`))
    )
    .then(() => ({ Bucket: s3Bucket, Key: key }));
  });
}

/**
 * Collect lambda code, and use it to update AWS Lambda function of the given name.
 * @param {string} startPath: Path the JS file that's the entry point to the lambda.
 * @param {string} options.region: Region to use, overriding config/env settings.
 * @param {string} options.lambdaEndpointUrl: Override Lambda endpoint url.
 * @param {Array<string>} options.browserifyArgs: arguments to pass to collect-js-deps.
 * @return {Promise<Object>} Promise for the response as returned by AWS Lambda UpdateFunctionCode.
 *  See http://docs.aws.amazon.com/lambda/latest/dg/API_UpdateFunctionCode.html
 */
function updateLambda(startPath, lambdaName, options) {
  console.log(`Packaging ${startPath} to update lambda ${lambdaName}`);
  const lambda = new AWS.Lambda({
    region: options.region,
    endpoint: options.lambdaEndpointUrl
  });
  return _makeTmpZipFile(startPath, options.browserifyArgs)
  .then(tmpPath => fse.readFile(tmpPath, {encoding: null}))
  .then(zipData =>
    lambda.updateFunctionCode({FunctionName: lambdaName, ZipFile: zipData}).promise())
  .then(resp => {
    console.log(`Updated lambda ${lambdaName} version ${resp.Version} ` +
      `(${resp.CodeSize} bytes) at ${resp.LastModified}`);
    return resp;
  });
}

// TODO: include configurable output, like
// logger = { info, debug }, defaulting to { info: console.log }
// and -v option that adds debug: console.debug

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
 * @param {string} templatePath: Path to JSON or YAML template file.
 * @param {string} options.region: Region to use, overriding config/env settings.
 * @param {string} options.s3Bucket: S3 bucket to which to upload (default 'aws-lambda-upload')
 * @param {string} options.s3Prefix: Prefix (folder) added to uploaded zip files (default '')
 * @param {string} options.s3EndpointUrl: Override S3 endpoint url.
 * @param {string} options.cfnEndpointUrl: Override CloudFormation endpoint url.
 * @param {Array<string>} options.browserifyArgs: arguments to pass to collect-js-deps.
 * @return {Promise<Object>} TODO
 */
function cloudformationPackage(templatePath, options) {
  console.log(`Packaging ${startPath} to update lambda ${lambdaName}`);
  return fse.readFile(templatePath, 'utf8')
  .then(data => Promise.resolve()
    .then(() => JSON.parse(data))
    .catch(() => yamlParse(data))
  )
  .catch(e => { throw new Error(`Unable to parse template: ${e}`); })
  .then(template => {
    const promises = [];
    Object.keys(template.Resources).forEach(key => {
      const res = template.Resources[key];
      if (res.Type === 'AWS::Lambda::Function') {
        promises.push(resolveCfnPath(key, res, 'Code',
          obj => ({S3Bucket: obj.Bucket, S3Key: obj.Key})));
      } else if (res.Type === 'AWS::Serverless::Function') {
        promises.push(resolveCfnPath(key, res, 'CodeUri',
          obj => `s3://${obj.Bucket}/${obj.Key}`));
      }
    });
    return Promise.all(promises)
    .then(() => template);
  });


  // Helper function to process a single property in the template file.
  function resolveCfnPath(key, resource, prop, converter) {
    const cfnValue = resource[prop];
    return Promise.resolve().then(() => {
      if (typeof cfnValue !== 'string' || /^(s3|https?):\/\//.test(cfnValue)) {
        console.log(`Template property ${prop} of ${key} is not a path; skipping`);
        return;
      }
      const cfnPath = path.resolve(path.dirname(templatePath), cfnValue);
      return fse.pathExists(cfnPath)
      .then(exists => {
        if (!exists) {
          console.log(`Template property ${prop} of ${key}: ${cfnPath} does not exist; skipping`);
        } else {
          return packageZipS3(cfnPath, options)
          .then(s3Info => {
            resource[prop] = converter(s3Info);
            console.log(`Template property ${prop} of ${key} updated`);
          });
        }
      });
    });
  }
}



/**
 * As cloudformationPackage, but writes the adjusted template to the given output file as JSON.
 * See cloudformationPackage() for other parameters.
 * @param {string} outputPath: Path to the JSON output file. May be '-' for stdout.
 * @return {Promise<void>} Promise that's resolved when the template has been written.
 */
function cloudformationPackageOutput(templatePath, outputPath, options) {
  return cloudformationPackage(templatePath, options)
  .then(template => {
    const json = JSON.stringify(template, null, {spaces: 2});
    if (outputPath === '-') {
      return process.stdout.writeAsync(json, 'utf8');
    } else {
      return fse.writeFile(outputPath, json);
    }
  });
}

// Helper predicate to use when catching exceptions from aws.
function ifErrorCode(code) {
  return err => (err.code === code);
}

/**
 * Main entry point when used from the command line.
 */
function main() {
  commander
  .description('Package node.js code for AWS lambda with its minimal dependencies.\n' +
			'Extra arguments given after -- will be passed to browserify')
  .usage('[options] -- [browserify-options] <start-file>')
	.option('--lambda, -l <name>', 'Name of lambda function to update')
	.option('--zip <output-path>', 'Save the packaged lambda code to a local zip file')
	.option('--s3', 'Save the packaged lambda code to S3, and print the S3 URI to stdout')
	.option('--cfn <output-path>', 'Interpret <start-path> as a CloudFormation template' +
		' (.json or .yml), and package lambda code mentioned there. Replaces code references' +
		' with S3 locations, and outpus adjusted template to <output-path> ("-" for stdout)')
	.option('--region, -r <string>', 'AWS region to use, for --lambda or --s3 flags')
	.option('--s3-bucket <string>', 'S3 bucket to which to upload zip files', 'aws-lambda-upload')
	.option('--s3-prefix <string>', 'Prefix (folder) added to zip files uploaded to S3', '')
	.option('--s3-endpoint-url <string>', 'Override S3 endpoint url', v => new AWS.Endpoint(v))
  .option('--tsconfig <path>', 'If given, support TypeScript, and use the given' +
		' config file, or directory containing tsconfig.json')
  .arguments('<start-file>')
  .parse(process.argv);

  const options = commander.opts();
  options.browserifyArgs = commander.args;

  if (!(options.lambda || options.zip || options.s3 || options.cfn)) {
    commander.help();
    process.exit(1);
  } else {
    return dispatchWork(options)
    .catch(err => {
      console.log('Error', err.message);
      process.exit(1);
    });
  }
}
exports.main = main;


function dispatchWork(options) {
	if (options.cfn) {
    // Interprets start_file differently, so doesn't make sense to combine with other options.
		return cloudformationPackageOutput(options.start_file, options.cfn, options);
  }
  return Promise.resolve()
  .then(() => options.zip && packageZipLocal(options.startFile, options.zip, options))
  .then(() => options.s3 && packageZipS3(options.startFile, options.s3, options))
  .then(() => options.lambda && updateLambda(options.startFile, options.lambda, options));
}
