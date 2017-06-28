# aws-lambda-upload

[![Build Status](https://travis-ci.org/gristlabs/aws-lambda-upload.svg?branch=master)](https://travis-ci.org/gristlabs/aws-lambda-upload)
[![npm version](https://badge.fury.io/js/aws-lambda-upload.svg)](https://badge.fury.io/js/aws-lambda-upload)

> Package and upload an AWS lambda with its minimal dependencies.

This module allows you to have files with AWS Lambda functions alongside other
code, and makes it easy to package and upload a lambda function with only those
dependencies that it needs.


## Installation

```
npm install --save-dev aws-lambda-upload
```

## Usage

```
$ $(npm bin)/aws-lambda-upload [--help] [-l <lambda>] [-r <region>] <start_file>
```

It assumes you already created a Lambda on AWS e.g. using [AWS Lambda
console](https://console.aws.amazon.com/lambda). If you have a Lambda called
`my_lambda`, and a file called `lib/my_lambda.js`, you can simply run

```
$ $(npm bin)/aws-lambda-upload lib/my_lambda.js
```

(If the name of the Lambda differs from the name of the file, specify it using `--lambda` option.)

If this file requires other files in your project, or in `node_modules/`,
that's great. All dependencies will be packaged into a temporary zip file and
uploaded to AWS to update the latest version of `my_lambda`.

Since the main file of a Lambda must be at top-level, and `lib/my_lambda.js`
isn't, a helper file `my_lambda.js` will be added to the zip archive for you,
and all imports will still work.

Note that it does NOT package your entire directory or all of `node_modules/`.
It uses [browserify](http://browserify.org/) to examind the `require()` calls
in your files, and recursively collect all dependencies. For files in
`node_modules/`, it also includes any `package.json` files as they affect the
import logic.

## AWS permissions

To be able to upload Lambda code, you need sufficient permissions. Read about
[configuring AWS
credentials](http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html)
for how to set credentials that AWS SDK an use.

The credentials you use need to
at least give you the permission of `lambda:UpdateFunctionCode` for the
resource of `arn:aws:lambda:<region>:<account-id>:function:<function-name>`.
Read more
[here](http://docs.aws.amazon.com/lambda/latest/dg/lambda-api-permissions-ref.html).
