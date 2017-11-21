"use strict";
/* global describe, it, beforeEach, afterEach, before, after */

const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const bluebird = require('bluebird');
const fse = require('fs-extra');
const tmp = bluebird.promisifyAll(require('tmp'));
const childProcess = bluebird.promisifyAll(require('child_process'));
const main = require('../dist/main.js');
const localstack = require('./localstack');
const AWS = require('aws-sdk');

chai.use(chaiAsPromised);
const assert = chai.assert;

tmp.setGracefulCleanup();
localstack.addServices(['s3']);

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
      ['test/fixtures/foo.js', false],
      ['test/fixtures/foo_abs.js', false],
      ['test/fixtures/foo_ts.ts', false],
      ['test/fixtures/lib', true],
      ['test/fixtures/lib/bar.js', false],
      ['test/fixtures/lib/baz_ts.ts', false],
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
      });
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
          });
        });
      });
    });
  });


    // TODO: ensure the result is runnable
    // TODO: want to test memoization, but it may be affecting all tests already.

  describe('packageZipS3', function() {

    chdirContext('test/fixtures');

    it('should upload to S3', function() {
      const s3EndpointUrl = localstack.getService('s3').endpoint;
      return main.packageZipS3('lib/bar.js', {logger, s3EndpointUrl})
      .then(s3Loc => {
        assert.deepEqual(s3Loc, {
          bucket: "aws-lambda-upload",
          key: "e0fdbbf73f40ad5316d38ec8173b2a64"
        });
        assert.match(log.find(l => /Bucket/.test(l)), /creating/);
        assert.match(log[log.length - 1], /uploaded/);

        const s3 = new AWS.S3({endpoint: s3EndpointUrl, s3ForcePathStyle: true});
        return s3.getObject({Bucket: s3Loc.bucket, Key: s3Loc.key}).promise();
      })
      .then(data => {
        return tmp.tmpNameAsync({postfix: '.zip'})
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
          key: "e0fdbbf73f40ad5316d38ec8173b2a64"
        });
        assert.match(log.find(l => /Bucket/.test(l)), /exists/);
        assert.match(log[log.length - 1], /skipping upload/);
      });
    });
  });
});

// TODO: mkae sure failing tests don't leave around /tmp/ files
