#!/usr/bin/env node

/***
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

/**
 * @file Example automation to construct an IGC asset XML file from a JSON Schema document
 * @license Apache-2.0
 * @requires ibm-iis-commons
 * @requires ibm-igc-rest
 * @requires ibm-igc-extensions
 * @requires fs-extra
 * @requires pretty-data
 * @requires yargs
 * @requires prompt
 * @param f {string} - JSON file for which to create IGC assets
 * @example
 * // creates and loads IGC assets based on the JSON Schema provided (and default credentials file in ~/.infosvrauth)
 * ./loadJSONSchemaDefinition.js -f MySchema.json
 * @example
 * // creates IGC assets XML file and saves into AssetsToLoad.xml; does not attempt to load to environment
 * ./loadJSONSchemaDefinition.js -f MySchema.json -o AssetsToLoad.xml
 */

const igcjson = require('../');
const commons = require('ibm-iis-commons');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const igcrest = require('ibm-igc-rest');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -f <path> -o <path> -a <authfile> -p <password>')
    .example('$0 -f MySchema.json', 'creates and loads IGC assets based on the JSON Schema provided (and default credentials file in ~/.infosvrauth)')
    .alias('f', 'file').nargs('f', 1).describe('f', 'JSON Schema file')
    .alias('a', 'authfile').nargs('a', 1).describe('a', 'Authorisation file containing environment context')
    .alias('p', 'password').nargs('p', 1).describe('p', 'Password for invoking REST API')
    .alias('o', 'output').nargs('o', 1).describe('o', 'XML output file')
    .demandOption(['f'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const bOutput = (argv.output !== undefined && argv.output !== "");

const envCtx = new commons.EnvironmentContext(null, argv.authfile);
if (bOutput) {
  argv.password = "unused";
}

prompt.override = argv;

const inputPrompt = {
  properties: {
    password: {
      hidden: true,
      required: true,
      message: "Please enter the password for user '" + envCtx.username + "': "
    }
  }
};
prompt.message = "";
prompt.delimiter = "";

prompt.start();
prompt.get(inputPrompt, function (errPrompt, result) {
  igcrest.setConnection(envCtx.getRestConnection(result.password));

  const igcObj = new igcjson.JSONSchemaOpenIGC();
  igcObj.readSchemaFromFile(argv.file);
  const xmlAssets = igcObj.getOpenIGCXML();

  if (bOutput) {
    const options = {
      "encoding": 'utf8',
      "mode": 0o644,
      "flag": 'w'
    };
    fs.writeFileSync(argv.output, pd.xml(xmlAssets), options);
  } else {
    igcrest.createBundleAssets(pd.xmlmin(xmlAssets), function(errCreate, resCreate) {
      if (errCreate !== null) {
        console.error("ERROR: Creating assets failed -- " + errCreate);
      } else {
        console.log("Assets created: " + pd.json(JSON.stringify(resCreate)));
      }
    });
  }

});
