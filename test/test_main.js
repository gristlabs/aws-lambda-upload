"use strict";
/* global describe, it, beforeEach, afterEach, before, after */

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const bluebird = require('bluebird');
const fse = require('fs-extra');
const path = require('path');
const util = require('util');
const tmp = bluebird.promisifyAll(require('tmp'));
const childProcess = bluebird.promisifyAll(require('child_process'));
const main = require('../dist/main.js');
const localstack = require('./localstack');
const AWS = require('aws-sdk');

chai.use(chaiAsPromised);
const assert = chai.assert;

tmp.setGracefulCleanup();
localstack.addServices(['s3', 'lambda', 'cloudformation']);

describe('spawn', function() {
  it('should resolve or reject returned promise', function() {
    return main.spawn('true', [])
    .then(() => main.spawn('false', []))
    .then(
      () => assert(false, "Command should have failed"),
      err => assert.equal(err.message, "Command failed with exit code 1")
    );
  });
});


describe('fsWalk', function() {
  it('should list all files recursively', function() {
    const entries = [];
    return main.fsWalk('test/fixtures', (p, st) => entries.push([p, st.isDirectory()]))
    .then(() => assert.deepEqual(entries, [
      ['test/fixtures', true],
      ['test/fixtures/cfn.yml', false],
      ['test/fixtures/foo.js', false],
      ['test/fixtures/foo_abs.js', false],
      ['test/fixtures/foo_ts.ts', false],
      ['test/fixtures/lib', true],
      ['test/fixtures/lib/bar.js', false],
      ['test/fixtures/lib/baz_ts.ts', false],
      ['test/fixtures/lib/lambda.js', false],
      ['test/fixtures/lib/lambda_dep.js', false],
      ['test/fixtures/node_modules', true],
      ['test/fixtures/node_modules/dep1', true],
      ['test/fixtures/node_modules/dep1/hello.js', false],
      ['test/fixtures/node_modules/dep1/package.json', false],
      ['test/fixtures/node_modules/dep2', true],
      ['test/fixtures/node_modules/dep2/package.json', false],
      ['test/fixtures/node_modules/dep2/world.js', false],
      ['test/fixtures/node_modules/dep3', true],
      ['test/fixtures/node_modules/dep3/bye.js', false],
      ['test/fixtures/node_modules/dep3/package.json', false],
      ['test/fixtures/tsconfig.json', false],
    ]));
  });
});

/**
 * Return promise for list of files in the archive, ignoring non-file lines and directories.
 */
function listZipNames(zipFile) {
  return childProcess.execFileAsync('unzip', ['-l', zipFile])
  .then(stdout => {
    // Include just the last word (file name)
    return stdout.split("\n").map(line => line.split(/ +/)[4])
    // Ignore non-word lines (e.g. Linux and Max differ on whether '----' is printed).
    .filter(name => name && /\w/.test(name))
    // Filter out directories and the "Name" header in the first line.
    .filter((name, i) => !(i === 0 && name === 'Name') && !name.endsWith('/'));
  });
}


/**
 * Unzip archive and run the entryFile using node. Returns promise for its stdout.
 */
function runZipFile(zipFile, entryFile) {
  return tmp.dirAsync({unsafeCleanup: true})
  .then(dir => {
    return childProcess.execFileAsync('unzip', ['-d', dir, zipFile])
    .then(() => childProcess.execFileAsync('node', [path.join(dir, entryFile)], {cwd: dir}));
  });
}

/**
 * Ensure that array contains elements matching each regexp in regexpList, in the order given.
 * Non-matching elements are ignored.
 */
function assertSubsetMatchesInOrder(array, regexpList) {
  function findNext(index, r) {
    for (let i = index; i < array.length; i++) {
      if (r.test(array[i])) { return i; }
    }
    assert.fail(array.slice(i), regexpList[r],
      `expected ${util.inspect(array.slice(i))} to include a match for ${util.inspect(r)}`);
  }

  let i = 0;
  for (const r of regexpList) {
    i = findNext(i, r) + 1;
  }
}

/**
 * Use in describe() to run tests with environment variable `name` set to `value`.
 */
function envContext(name, value) {
  let old;
  before(() => { old = process.env[name]; process.env[name] = value; });
  after(() => { process.env[name] = old; });
}

/**
 * Use in describe() to run tests with current directory set to dir.
 */
function chdirContext(dir) {
  let old;
  before(() => { old = process.cwd(); process.chdir(dir); });
  after(() => { process.chdir(old); });
}


describe('aws-lambda-upload', function() {
  this.timeout(30000);      // Generous timeout for TravisCI.

  let log = [];
  const logger = {
    info(msg) { log.push(msg); },
    debug(msg) { log.push(msg); },
  };
  beforeEach(function() { log = []; });

  describe('packageZipLocal', function() {
    let localZipPath;

    chdirContext('test/fixtures');

    beforeEach(() => tmp.tmpNameAsync({postfix: '.zip'}).then(t => { localZipPath = t; }));
    afterEach(() => fse.remove(localZipPath));

    it('should create a zip-file', function() {
      return main.packageZipLocal('foo.js', localZipPath, {logger})
      .then(result => assert.equal(result, localZipPath))
      .then(() => listZipNames(localZipPath))
      .then(names => {
        assert.deepEqual(names, [
          'foo.js',
          'lib/bar.js',
          'node_modules/dep1/hello.js',
          'node_modules/dep1/package.json',
          'node_modules/dep2/package.json',
          'node_modules/dep2/world.js',
        ]);
        assert.match(log[0], /Packaging foo.js/);
      })
      .then(() => runZipFile(localZipPath, 'foo'))
      .then(outputLines => assert.deepEqual(outputLines,
        'imported dep1\n' +
        'imported dep2\n' +
        'imported lib/bar.js\n' +
        'imported foo.js\n'
      ));
    });

    it('should create a helper file if startFile is not at top level', function() {
      return main.packageZipLocal('lib/bar.js', localZipPath, {logger})
      .then(result => assert.equal(result, localZipPath))
      .then(() => listZipNames(localZipPath))
      .then(names => {
        assert.deepEqual(names, [
          "bar.js",
          "lib/bar.js",
          'node_modules/dep2/package.json',
          'node_modules/dep2/world.js',
        ]);
        assert.match(log[0], /Packaging lib\/bar.js/);
      })
      .then(() => childProcess.execFileAsync('unzip', ['-q', '-c', localZipPath, 'bar.js']))
      .then(contents => assert.include(contents, 'require("./lib/bar.js")'))
      .then(() => runZipFile(localZipPath, 'bar'))
      .then(outputLines => assert.deepEqual(outputLines,
        'imported dep2\n' +
        'imported lib/bar.js\n'
      ));
    });

    it('should reuse existing file when a cache is used', function() {
      const cache = new Map();
      return main.packageZipLocal('foo.js', localZipPath, {logger})
      .then(() => { log.length = 0; })
      .then(() => main.packageZipLocal('foo.js', localZipPath, {logger, cache}))
      .then(() => {
        assert.isTrue(log.some(l => /Collecting/.test(l)));
        assert.isFalse(log.some(l => /Reusing cached/.test(l)));
        log.length = 0;
      })
      .then(() => main.packageZipLocal('foo.js', localZipPath, {logger, cache}))
      .then(() => {
        assert.isFalse(log.some(l => /Collecting/.test(l)));
        assert.isTrue(log.some(l => /Reusing cached/.test(l)));
      });
    });

    describe('browserify options', function() {
      it('should fail when missing necessary ones', function() {
        // Absolute imports will (and should) fail without extra browserify options.
        return assert.isRejected(main.packageZipLocal('foo_abs.js', localZipPath, {logger}),
          /Cannot find.*lib\/bar/);
      });

      it('should support ignoreMissing option', function() {
        return main.packageZipLocal('foo_abs.js', localZipPath, {logger, browserifyArgs: ['--im']})
        .then(() => listZipNames(localZipPath))
        .then(names => {
          assert.deepEqual(names, [
            'foo_abs.js',
            'node_modules/dep1/hello.js',
            'node_modules/dep1/package.json',
          ]);
        });
      });

      describe('with NODE_PATH', function() {
        envContext('NODE_PATH', '.');

        it('should respect NODE_PATH', function() {
          return main.packageZipLocal('foo_abs.js', localZipPath, {logger})
          .then(result => assert.equal(result, localZipPath))
          .then(() => listZipNames(localZipPath))
          .then(names => {
            assert.deepEqual(names, [
              'foo_abs.js',
              'lib/bar.js',
              'node_modules/dep1/hello.js',
              'node_modules/dep1/package.json',
              'node_modules/dep2/package.json',
              'node_modules/dep2/world.js',
            ]);
            assert.match(log[0], /Packaging foo_abs.js/);
          });
        });

        it('should support typescript with tsconfig option', function() {
          return main.packageZipLocal('foo_ts.ts', localZipPath, {logger, tsconfig: '.'})
          .then(() => listZipNames(localZipPath))
          .then(names => {
            assert.deepEqual(names, [
              'foo_ts.js',
              'lib/bar.js',
              'lib/baz_ts.js',
              'node_modules/dep1/hello.js',
              'node_modules/dep1/package.json',
              'node_modules/dep2/package.json',
              'node_modules/dep2/world.js',
              'node_modules/dep3/bye.js',
              'node_modules/dep3/package.json',
            ]);
            assert.match(log[0], /Packaging foo_ts.ts/);
          })
          .then(() => runZipFile(localZipPath, 'foo_ts'))
          .then(outputLines => assert.deepEqual(outputLines,
            'imported dep1\n' +
            'imported dep2\n' +
            'imported lib/bar.js\n' +
            'imported dep3\n' +
            'imported lib/baz_ts.ts true\n' +
            'imported foo_ts.ts true\n'
          ));
        });
      });
    });
  });

  describe('packageZipS3', function() {

    chdirContext('test/fixtures');

    it('should upload to S3', function() {
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      return main.packageZipS3('lib/bar.js', {logger, s3EndpointUrl})
      .then(s3Loc => {
        assert.deepEqual(s3Loc, {
          bucket: "aws-lambda-upload",
          key: "731c671e440cb3cea7bdc0b5bcaada2d.zip"
        });
        assert.match(log.find(l => /Bucket/.test(l)), /creating/);
        assert.match(log[log.length - 1], /uploaded/);

        const s3 = new AWS.S3({endpoint: s3EndpointUrl, s3ForcePathStyle: true});
        return s3.getObject({Bucket: s3Loc.bucket, Key: s3Loc.key}).promise();
      })
      .then(data => {
        return tmp.fileAsync({postfix: '.zip'})
        .then(tmpFile => fse.writeFile(tmpFile, data.Body)
          .then(() => listZipNames(tmpFile)));
      })
      .then(names => {
        assert.deepEqual(names, [
          "bar.js",
          "lib/bar.js",
          'node_modules/dep2/package.json',
          'node_modules/dep2/world.js',
        ]);
      });
    });

    it('should skip upload if such file already exists', function() {
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      return main.packageZipS3('lib/bar.js', {logger, s3EndpointUrl})
      .then(s3Loc => {
        assert.deepEqual(s3Loc, {
          bucket: "aws-lambda-upload",
          key: "731c671e440cb3cea7bdc0b5bcaada2d.zip"
        });
        assert.match(log.find(l => /Bucket/.test(l)), /exists/);
        assert.match(log[log.length - 1], /skipping upload/);
      });
    });

    it('should respect s3 parameters', function() {
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      const params = {logger, s3EndpointUrl, s3Bucket: 'foo', s3Prefix: 'bar/baz/'};
      return main.packageZipS3('lib/bar.js', params)
      .then(s3Loc => {
        assert.deepEqual(s3Loc, {
          bucket: "foo",
          key: "bar/baz/731c671e440cb3cea7bdc0b5bcaada2d.zip"
        });
        assert.match(log[log.length - 1], /uploaded/);
      });
    });
  });

  describe('updateLambda', function() {
    chdirContext('test/fixtures');

    it('should update lambdas', function() {
      const lambdaEndpointUrl = localstack.getService('lambda').endpoint;
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      const region = 'us-fake';

      const lambda = new AWS.Lambda({region, endpoint: lambdaEndpointUrl});
      return main.packageZipS3('lib/lambda.js', {logger, region, s3EndpointUrl})
      .then(s3Loc => lambda.createFunction({
        FunctionName: 'testMyLambda',
        Runtime: 'nodejs6.10',
        Handler: 'lambda.myLambda',
        Code: {S3Bucket: s3Loc.bucket, S3Key: s3Loc.key},
        Role: 'test-role'
      }).promise())
      .then(() => main.updateLambda('lib/lambda.js', 'testMyLambda',
        {logger, region, lambdaEndpointUrl}))
      // TODO: We can't actually test it easily because localstack only supports lambdas with
      // docker, and that seems to heavy a dependency for this kind of test.
      // .then(() => lambda.invoke({FunctionName: 'testMyLambda'}).promise())
      .then((data) => {
        assert.isTrue(log.some(l => /Updated labmda testMyLambda/));
      });
    });
  });

  describe('cloudformationPackage', function() {
    // TODO: should not need chdir, b/c path should be relative to template. Maybe?
    // chdirContext('test/fixtures');
    it('should upload code and transform cloudformation template', function() {
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      const region = 'us-fake';
      return main.cloudformationPackage('test/fixtures/cfn.yml', {logger, region, s3EndpointUrl})
      .then(transformed => {
        assert.deepEqual(transformed, {
          "AWSTemplateFormatVersion": "2010-09-09",
          "Transform": "AWS::Serverless-2016-10-31",
          "Resources": {
            "MyFunction": {
              "Type": "AWS::Serverless::Function",
              "Properties": {
                "Handler": "index.handler",
                "Runtime": "nodejs6.10",
                "CodeUri": "s3://aws-lambda-upload/6c2d71ca8a04470fbb7c2da5e87dd8f2.zip"
              }
            },
            "MyFunction2": {
              "Type": "AWS::Lambda::Function",
              "Properties": {
                "FunctionName": "myTestLambda,",
                "Handler": "lambda.myLambda,",
                "Runtime": "nodejs6.10,",
                "Code": {
                  "S3Bucket": "aws-lambda-upload",
                  "S3Key": "6c2d71ca8a04470fbb7c2da5e87dd8f2.zip"
                }
              }
            }
          }
        });

        assertSubsetMatchesInOrder(log, [
          /Collecting files.*lib\/lambda.js/,
          /s3:.* uploaded/,
          /Reusing cached.*lib\/lambda.js/,
          /s3:.* skipping upload/
        ]);
      });
    });
  });
});
