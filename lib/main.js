"use strict";

const path = require('path');
const bluebird = require('bluebird');
const fs = bluebird.promisifyAll(require('fs'));
const child_process = bluebird.promisifyAll(require('child_process'));
const browserify = require('browserify');
const commander = require('commander');
const through = require('through2');
const tmp = bluebird.promisifyAll(require('tmp'));
const AWS = require('aws-sdk');


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


/**
 * Given a startFile path, returns a Promise for an array of all dependencies to include in the
 * package, including any necessary package.json files.
 */
function listDependencies(startFile) {
  var b = browserify({
      entries: [startFile],
      builtins: false,
      commondir: false,
      browserField: false,
      dedupe: true,
      ignoreMissing: true,
      debug: false,
  });

  b.exclude('aws-sdk');

  let paths = [];
  b.pipeline.get('deps').push(through.obj((row, enc, next) => {
    paths.push(path.relative('', row.file || row.id).replace(path.sep, '/'));
    next();
  }));

  return bluebird.fromCallback(cb => b.bundle(cb))
  .then(() => getPackageFiles(paths))
  .then(pkgPaths => paths.concat(pkgPaths).sort());
}
exports.listDependencies = listDependencies;


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


/**
 * Packages and zips all dependencies of startFile into the given zip file. If the startFile is
 * not at top-level, creates a helper top-level alias for it with the same basename.
 *
 * @param {String} startFile: Path to the start file.
 * @param {String} zipFile: The name of the zip file to create. It will be overwritten if exists.
 * @returns {Promise} Promise that resolves on success.
 */
function packageLambda(startFile, zipFile) {
  return listDependencies(startFile)
  .then(paths =>
    fs.unlinkAsync(zipFile).catch(() => {})
    .then(() => spawn('zip', ['-q', zipFile].concat(paths)))
  )
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
  })
}
exports.packageLambda = packageLambda;


/**
 * Packages and upload startFile with all its dependencies function.
 * @param {String} startFile: Path to the start file.
 * @param {String} options.lambda: The name of the lambda. Defaults to basename of startFile.
 * @param {String} options.region: The region to use for AWS.
 * @returns {Promise} Promise that resolves to the return value of AWS.Lambda.updateFunctionCode.
 */
function uploadLambda(startFile, options) {
  let lambdaName = options.lambda || path.basename(startFile, '.js');
  let zipFile;

  return tmp.fileAsync({ prefix: 'aws-lambda', postfix: '.zip', discardDescriptor: true })
  .then(_zipFile => {
    zipFile = _zipFile;
    console.log(`Building '${startFile}' into '${zipFile}'`);
    return packageLambda(startFile, zipFile);
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


/**
 * Main entry point when used from the command line.
 */
function main() {
  commander
  .option('-l, --lambda <string>', 'Name of lambda. Defaults to basename of start_file')
  .option('-r, --region <string>', 'AWS region to use.')
  .option('-o, --output <path>', 'Just create a zip file with the packaged lambda code')
  .arguments('<start_file>')
  .action((startFile, options) => uploadLambda(startFile, options.opts()));

  commander.parse(process.argv);
  if (commander.args.length < 1) {
    commander.help();
  }
}
exports.main = main;
