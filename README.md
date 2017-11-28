# aws-lambda-upload

[![Build Status](https://travis-ci.org/gristlabs/aws-lambda-upload.svg?branch=master)](https://travis-ci.org/gristlabs/aws-lambda-upload)
[![npm version](https://badge.fury.io/js/aws-lambda-upload.svg)](https://badge.fury.io/js/aws-lambda-upload)

> Package node.js code for AWS lambda with its minimal dependencies.

This module allows you to have node.js files for AWS Lambda fuction alongside other code, and makes it
easy to package a lambda function with only those dependencies that it needs. You can them update
a lambda directly, or prepare the packaged code in local or S3 zip archive, including for use with
CloudFormation.

## Installation

```
npm install --save-dev aws-lambda-upload
```

## Usage

```
$(npm bin)/aws-lambda-upload [options] <start-file>
```
Here, `<start-file>` is the path of the JS file to serve as the entry point into the Lambda. Note that in all cases, you'll use the basename of `<start-file>` as the filename to use for Lambda handler.

#### Update existing lambda

Use `--lambda <name>` flag to update a Lambda with the given name that you have previously created on AWS (e.g. using [AWS Lambda
console](https://console.aws.amazon.com/lambda)).

Available programmatically as `updateLambda(startPath, lambdaName, options)`.

#### Saving a local zip file

Use `--zip <path>` flag to save the packaged lambda code to a zip file. It may then be used with e.g. `aws lambda update-function-code` command or as in a CloudFormation template with `aws cloudformation package` command.

Available programmatically as `packageZipLocal(startPath, outputZipPath, options)`.

#### Saving a zip file to S3

Use `--s3` to save the packaged lambda code to S3, and print the S3 URI to stdout.

The zip file will be saved to the bucket named by `--s3-bucket` flag (defaulting to `"aws-lambda-upload"`),
and within that to folder (prefix) named by `--s3-prefix` flag (defaulting to empty). The basename of the
file will be its MD5 checksum (which is exactly what `aws cloudformation package` does), which avoids
duplication when uploading identical files.

Available programmatically as `packageZipS3(startPath, options)`.

#### Package for CloudFormation template

Use `--cfn <path>` flag to interpret `<start-path>` as the path to a CloudFormation template (.json or .yml file), package
any mentioned code to S3, replace with S3 locations, and output the adjusted template as JSON to `<path>` (`-` for stdout).

This is similar to `aws cloudformation package` command. It will process the following keys in the template:
* For `Resource` with `Type: AWS::Lambda::Function`, processes `Code` property.
* For `Resource` with `Type: AWS::Serverless::Function`, processes `CodeUri` property.

In both cases, if the relevant property is a file path, interprets it as a start JS file,
packages it with `packageZipS3()` and replaces the property with S3 information
in the format required by CloudFormation. If file path is relative, it's interpreted relative to the directory of the template.

Available programmatically as `cloudformationPackage(templatePath, outputPath, options)`

## Collecting dependencies

If your entry file requires other files in your project, or in `node_modules/`,
that's great. All dependencies will be collected and packaged into a temporary zip file.

Note that it does NOT package your entire directory or all of `node_modules/`.
It uses [collect-js-deps](https://github.com/gristlabs/collect-js-deps)
(which uses [browserify](http://browserify.org/)) to examine the `require()` calls
in your files, and recursively collects all dependencies. For files in
`node_modules/`, it also includes any `package.json` files as they affect the
import logic.

Actually, all browserify options are supported, by including them after `--` on the command line
(`<start-path>` should come before that).

Since the main file of a Lambda must be at top-level, if `<start-path>` is in a subdirectory
(e.g. `lib/my_lambda.js`), a same-named top-level helper file (e.g. `my_lambda.js`) will be added
to the zip archive for you. It's a one-liner that re-exports the entry module to let you use it
as the Lambda's main file.

#### Supports TypeScript!

With `--tsconfig <path>`, you may specify a path to `tsconfig.json` or to the directory containing it,
and typescript dependencies will be compiled to JS and included. You'll have to have
[tsify](https://github.com/TypeStrong/tsify) installed.

It is a convenience shortcut for including the [tsify](https://github.com/TypeStrong/tsify) browserify plugin,
and is equivalent to including this browserify option `-- -p [ tsify -p <path> ]` to `collect-js-deps`.

## AWS permissions

To be able to update Lambda code or upload anything to S3, you need sufficient permissions. Read about
[configuring AWS
credentials](http://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html)
for how to set credentials that AWS SDK can use.

To use `--lambda` flag, the credentials you use need to
at least give you the permission of `lambda:UpdateFunctionCode` for the
resource of `arn:aws:lambda:<region>:<account-id>:function:<function-name>`.
Read more [here](http://docs.aws.amazon.com/lambda/latest/dg/lambda-api-permissions-ref.html).

To use `--s3` or `--cfn` flags, the credentials need to give you the permission to read and create objects in the relevant S3 bucket.
E.g. the following policy works for the default bucket used by `aws-lambda-upload`:

<details>
  <summary>Suggested IAM Policy for default S3 bucket</summary>

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:CreateBucket",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::aws-lambda-upload"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObjectVersion"
            ],
            "Resource": [
                "arn:aws:s3:::aws-lambda-upload/*"
            ]
        }
     ]
 }
```
</details>

## Running tests

Before you run tests for the first time, you need to set up
[localstack](https://github.com/localstack/localstack). You can do it with

```
npm run setup-localstack
```

Note that localstack has a number of [requirements](https://github.com/localstack/localstack#requirements).

Once set up, you can run tests with `npm test` as usual.
