"use strict";
/* global describe, it, beforeEach, afterEach */

const assert = require('chai').assert;
const bluebird = require('bluebird');
const tmp = bluebird.promisifyAll(require('tmp'));
const child = bluebird.promisifyAll(require('child_process'));
const main = require('../dist/main.js');

tmp.setGracefulCleanup();

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


/*
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
    ]))
  });

  it("should support ignoreMissing option", function() {
    // Absolute imports will fail without some help.
    return main.listDependencies('test/fixtures/abs.js')
    .then(() => assert(false, 'Expected listDependencies abs.js to fail'),
      (err) => assert(/Cannot find.*lib\/dep/.test(err.message))
    )

    // But with ignoreMissing=true, they'll work, and find as much as they find.
    .then(() => main.listDependencies('test/fixtures/abs.js', {ignoreMissing: true}))
    .then(paths => assert.deepEqual(paths, [
      "test/fixtures/abs.js",
      "test/fixtures/node_modules/dep1/hello.js",
      "test/fixtures/node_modules/dep1/package.json",
    ]));
  });

  it("should support paths option", function() {
    return main.listDependencies('test/fixtures/abs.js', {paths: ['test/fixtures']})
    .then(paths => assert.deepEqual(paths, [
      "test/fixtures/abs.js",
      "test/fixtures/lib/dep.js",
      "test/fixtures/node_modules/dep1/hello.js",
      "test/fixtures/node_modules/dep1/package.json",
      "test/fixtures/node_modules/dep2/bye.js",
      "test/fixtures/node_modules/dep2/package.json",
    ]));
  });

  it("should find typescript files", function() {
    this.timeout(5000);
    return main.listDependencies('test/fixtures/ts1.js', {
      paths: ['test/fixtures'],
      tsconfig: 'test/fixtures/tsconfig.json'
    })
    .then(paths => assert.deepEqual(paths, [
      "test/fixtures/lib/dep.js",
      "test/fixtures/lib/ts2.ts",
      "test/fixtures/node_modules/dep1/hello.js",
      "test/fixtures/node_modules/dep1/package.json",
      "test/fixtures/node_modules/dep2/bye.js",
      "test/fixtures/node_modules/dep2/package.json",
      "test/fixtures/ts1.js",
    ]));
  });
});
*/



describe('packageLambda', function() {
  let cwd, log = [];
  const logger = {
    info(msg) { log.push(msg); },
    debug(msg) { log.push(msg); },
  };

  beforeEach(function() {
    cwd = process.cwd();
    process.chdir('test/fixtures');
  });

  afterEach(function() {
    process.chdir(cwd);
    log.length = 0;
  });

  it('should create a zip-file', function() {
    return tmp.tmpNameAsync({prefix: 'test-aws-lamda-upload'})
    .then(zipFile => {
      return main.packageZipLocal('foo.js', zipFile, {browserifyArgs: [], logger})
      .then(result => assert.equal(result, zipFile))
      .then(() => listZipNames(zipFile));
    })
    .then(names => {
      assert.deepEqual(names, [
        "foo.js",
        "lib/",
        "lib/dep.js",
        "node_modules/",
        "node_modules/dep1/",
        "node_modules/dep1/hello.js",
        "node_modules/dep1/package.json",
        "node_modules/dep2/",
        "node_modules/dep2/bye.js",
        "node_modules/dep2/package.json",
      ]);
      assert.match(log[0], /Packaging foo.js/);
    });
  });

  it('should create a helper file if startFile is not at top level', function() {
    return tmp.tmpNameAsync({prefix: 'test-aws-lamda-upload'})
    .then(zipFile => {
      return main.packageZipLocal('lib/bar.js', zipFile, {browserifyArgs: [], logger})
      .then(result => assert.equal(result, zipFile))
      .then(() => listZipNames(zipFile));
    })
    .then(names => {
      assert.deepEqual(names, [
        "bar.js",
        "lib/",
        "lib/bar.js",
        "lib/dep.js",
        "node_modules/",
        "node_modules/dep2/",
        "node_modules/dep2/bye.js",
        "node_modules/dep2/package.json",
      ]);
      assert.match(log[0], /Packaging lib\/bar.js/);
    });
  });

  function listZipNames(zipFile) {
    return child.execFileAsync('unzip', ['-l', zipFile])
    .then(stdout => {
      // Include just the last word (file name), and ignore lines that are empty or have no word
      // chars. (E.g. Linux and Max differ on whether '----' is printed.)
      return stdout.split("\n").map(line => line.split(/ +/)[4])
        .filter(name => name && /\w/.test(name))
        // Also filter out the "Name" header in the first line.
        .filter((name, i) => !(i === 0 && name === 'Name'));
    });
  }
});
