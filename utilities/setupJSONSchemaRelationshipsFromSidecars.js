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
 * @file Example to setup relationships between JSON Schema objects as a second-pass
 * @license Apache-2.0
 * @requires ibm-iis-commons
 * @requires ibm-igc-rest
 * @requires yargs
 * @requires prompt
 * @example
 * // inter-relates any JSON Schema objects where a $ref matches the id of another object (must be done as a second pass)
 * ./setupJSONSchemaRelationships.js -f MySchema.json
 */

const commons = require('ibm-iis-commons');
const igcrest = require('ibm-igc-rest');
const fs = require('fs-extra');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -f <path> -a <authfile> -p <password>')
    .example('$0 -f MySchema.json', 'inter-relates JSON Schema objects to terms that generated them (using default credentials file in ~/.infosvrauth)')
    .alias('f', 'file').nargs('f', 1).describe('f', 'JSON Schema file')
    .alias('a', 'authfile').nargs('a', 1).describe('a', 'Authorisation file containing environment context')
    .alias('p', 'password').nargs('p', 1).describe('p', 'Password for invoking REST API')
    .demandOption(['f'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const envCtx = new commons.EnvironmentContext(null, argv.authfile);
prompt.override = argv;

// To cache things we've already searched for
const hmJSONIdToDetails = {};

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

  // Read in the JSON Schema
  const schema  = JSON.parse(fs.readFileSync(argv.file, 'utf8'));
  const sidecar = JSON.parse(fs.readFileSync(argv.file + '.igc', 'utf8'));

  const qGetSchemaRefs = {
    "types": [ "$JSON_Schema-JSchema", "$JSON_Schema-JSObject" ],
    "properties": [ "name", "$ref", "$id" ],
    "where": {
      "conditions": [{
        "property": "name",
        "operator": "=",
        "value": schema.title
      }],
      "operator": "and"
    },
    "pageSize": 100
  };

  igcrest.search(qGetSchemaRefs).then(function(res) {
    igcrest.getAllPages(res.items, res.paging).then(function(allSchemaRefs) {

      for (let i = 0; i < allSchemaRefs.length; i++) {

        const updates = {
          "assigned_to_terms": {
            "items": sidecar._id
          }
        }

        igcrest.update(allSchemaRefs[i]._id, updates).then(function(success) {
          console.log("Successfully updated relationship (from " + allSchemaRefs[i]._id + "): " + JSON.stringify(success));
        }, function(failure) {
          console.log("ERROR: Update failed -- " + failure);
        });

      }

    });
  });

});
