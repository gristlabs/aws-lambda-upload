"use strict";

require('./bar.js');
const lambdaDep = require('./lambda_dep.js');

exports.myLambda = function(event, context, callback) {
  callback(lambdaDep.doSomething());
};
