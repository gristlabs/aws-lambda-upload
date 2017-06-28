"use strict";
/* global describe, it, beforeEach, afterEach */

let assert = require('assert');
let bluebird = require('bluebird');
let tmp = bluebird.promisifyAll(require('tmp'));
let child = bluebird.promisifyAll(require('child_process'));
let main = require('../lib/main.js');

tmp.setGracefulCleanup();

describe("listDependencies", function() {
  it("should recursively find dependencies and package.json files", function() {
    return main.listDependencies('test/fixtures/foo.js')
    .then(paths => assert.deepEqual(paths, [
      "test/fixtures/foo.js",
      "test/fixtures/lib/dep.js",
      "test/fixtures/node_modules/dep1/hello.js",
      "test/fixtures/node_modules/dep1/package.json",
      "test/fixtures/node_modules/dep2/bye.js",
      "test/fixtures/node_modules/dep2/package.json",
    ]))
    .then(() => main.listDependencies('test/fixtures/lib/bar.js'))
    .then(paths => assert.deepEqual(paths, [
      "test/fixtures/lib/bar.js",
      "test/fixtures/lib/dep.js",
      "test/fixtures/node_modules/dep2/bye.js",
      "test/fixtures/node_modules/dep2/package.json",
    ]));
  });
});


describe('spawn', function() {
  it('should resolve or reject returned promise', function() {
    return main.spawn('true', [])
    .then(() => main.spawn('false', []))
    .then(
      () => assert(false, "Command should have failed"),
      err => assert.equal(err.message, "Command failed with exit code 1")
    );
  });
})


describe('packageLambda', function() {
  let cwd;
  beforeEach(function() {
    cwd = process.cwd();
    process.chdir('test/fixtures');
  });

  afterEach(function() {
    process.chdir(cwd);
  });

  it('should create a zip-file', function() {
    let zipFile;
    return tmp.fileAsync({prefix: 'test-aws-lamda-upload', discardDescriptor: true})
    .then(tmpPath => { zipFile = tmpPath; })
    .then(() => main.packageLambda('foo.js', zipFile))
    .then(() => child.execFileAsync('unzip', ['-l', zipFile]))
    .then(stdout => {
      assert.deepEqual(stdout.split("\n").map(line => line.split(/ +/)[4]).filter(Boolean), [
        "Name",
        "----",
        "foo.js",
        "lib/dep.js",
        "node_modules/dep1/hello.js",
        "node_modules/dep1/package.json",
        "node_modules/dep2/bye.js",
        "node_modules/dep2/package.json",
      ]);
    });
  });

  it('should create a helper file if startFile is not at top level', function() {
    let zipFile;
    return tmp.fileAsync({prefix: 'test-aws-lamda-upload', discardDescriptor: true})
    .then(tmpPath => { zipFile = tmpPath; })
    .then(() => main.packageLambda('lib/bar.js', zipFile))
    .then(() => child.execFileAsync('unzip', ['-l', zipFile]))
    .then(stdout => {
      assert.deepEqual(stdout.split("\n").map(line => line.split(/ +/)[4]).filter(Boolean), [
        "Name",
        "----",
        "lib/bar.js",
        "lib/dep.js",
        "node_modules/dep2/bye.js",
        "node_modules/dep2/package.json",
        "bar.js",
      ]);
    });
  });
});
