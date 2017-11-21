/**
 * This file starts up "localstack" before running mocha tests.
 * Usage:
 *    const localstack = require('./localstack');
 *    localstack.addServices(['dynamodb', 'sqs'])
 *
 * Later inside tests you may rely on these services, and get their endpoint with:
 *    localstack.getService('sqs').endpoint    // Returns 'http://localhost:4576'
 */
'use strict';
/* global before, after */

const assert = require('chai').assert;
const childProcess = require('child_process');

const LSTACK_CMD = ['venv/bin/python', 'test/localstack_patched.py'];
const SERVICE_REGEX = /Starting mock (.+?) \(http port (\d+)\)/;
const STARTED_REGEX = /^Ready.$/;

let lstackServices = new Map();
let lstackProcess = null;

/**
 * In any test that requires localstack services, just declare the needed services:
 *   const localstack = require('./localstack');
 *   localstack.addServices(['dynamodb', 'sqs']);
 */
function addServices(services) {
  assert.isArray(services);
  for (let service of services) {
    lstackServices.set(service, null);
  }
}
exports.addServices = addServices;


/**
 * Returns the endpoint for any of the services you requested with addServices().
 * @returns {Object} E.g. { endpoint: 'http://localhost:1234', host: 'localhost', port: 1234 }
 *                   or null if the service isn't recognized.
 */
function getService(service) {
  return lstackServices.get(service) || null;
}
exports.getService = getService;


// Localstack uses human-friendly names to report which port each service is started on. We can
// get the service name as used when requesting a service by removing spaces and lowercasing (so
// far seems sufficient).
function reportedNameToServiceName(reportedName) {
  return reportedName.replace(/\s/g, '').toLowerCase();
}


// Register a global hook to start localstack.
before(function() {
  if (lstackServices.size === 0) { return; }
  this.timeout(60000);
  const serviceString = Array.from(lstackServices.keys()).sort().join(',');
  process.stderr.write(`Starting localstack for ${serviceString}...`);

  return new Promise((resolve, reject) => {
    lstackProcess = childProcess.spawn(LSTACK_CMD[0], LSTACK_CMD.slice(1).concat('start'), {
      env: { SERVICES: serviceString },
      stdio: ['ignore', 'pipe', process.stderr],
      shell: false
    });
    lstackProcess.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        console.warn(`localstack exited with code ${code} signal ${signal}`);
      }
      lstackProcess = null;
      reject(new Error('localstack exited'));
    });
    lstackProcess.on('error', (err) => {
      console.warn(`localstack could not be spawned: ${err}`);
      lstackProcess = null;
      reject(err);
    });

    let partial = '';
    lstackProcess.stdout.on('data', (data) => {
      // This pattern processes stdout stream line by line even if individual `data` buffers get
      // split elsewhere than on newlines.
      partial += data.toString('utf8');
      let newline;
      while ((newline = partial.indexOf("\n")) !== -1) {
        let line = partial.slice(0, newline).trim();
        partial = partial.slice(newline + 1);
        // console.log("LOCALSTACK:", line);

        let matches;
        if ((matches = SERVICE_REGEX.exec(line)) !== null) {
          // If a line is that a service is getting started, save its endpoint.
          let serviceName = reportedNameToServiceName(matches[1]);
          let port = parseInt(matches[2], 10);
          process.stderr.write(` ${serviceName}=${port}`);
          lstackServices.set(serviceName, {
            host: 'localhost',
            port: port,
            endpoint: `http://localhost:${port}`
          });

        } else if (STARTED_REGEX.exec(line)) {
          process.stderr.write('. Ready.\n');
          // If a line is that localstack is ready, resolve the promise so that tests can start.
          resolve();
        }
      }
    });
  });
});

// Register a global hook to stop localstack.
after(function() {
  this.timeout(15000);
  if (!lstackProcess) { return; }
  process.stderr.write('\nStopping localstack');
  return new Promise((resolve, reject) => {
    lstackProcess.on('error', reject);
    lstackProcess.on('close', resolve);
    lstackProcess.kill();
  });
});
