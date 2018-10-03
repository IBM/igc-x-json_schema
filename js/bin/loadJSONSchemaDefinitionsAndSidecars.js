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
const path = require('path');
const commons = require('ibm-iis-commons');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const igcrest = require('ibm-igc-rest');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -d <path> -a <authfile> -p <password>')
    .example('$0 -d /schema/location', 'creates and loads OpenIGC assets based on the JSON Schema files in the directory provided (and default credentials file in ~/.infosvrauth)')
    .alias('d', 'directory').nargs('d', 1).describe('f', 'Directory containing JSON Schema files and sidecars')
    .alias('a', 'authfile').nargs('a', 1).describe('a', 'Authorisation file containing environment context')
    .alias('p', 'password').nargs('p', 1).describe('p', 'Password for invoking REST API')
    .demandOption(['d'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const envCtx = new commons.EnvironmentContext(null, argv.authfile);

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
  igcrest.setConnection(envCtx.getRestConnection(result.password, 1));
  igcrest.openSession().then(function() {

    // Get listing of files
    const aFiles = fs.readdirSync(argv.directory);
    
    // 1 - first pass: create any JSON Schema OpenIGC assets (processing only the .json files)
    const igcCreationPromises = aFiles.map(function(filename) {
      return new Promise(function(resolve, reject) {
        if (path.extname(filename) === '.json') {
          const igcObj = new igcjson.JSONSchemaOpenIGC();
          const aWarns = igcObj.readSchemaFromFile(argv.directory + path.sep + filename);
          if (aWarns.length === 0) {
            igcrest.createBundleAssets(pd.xmlmin(igcObj.getOpenIGCXML())).then(function(success) {
              console.log("Assets created for: " + filename);
              resolve("Assets created: " + pd.json(JSON.stringify(success)));
            }, function(failure) {
              console.error("ERROR: Creating assets for '" + filename + "' failed -- " + failure);
              reject("ERROR: Creating assets for '" + filename + "' failed -- " + failure);
            });
          } else {
            console.log("Skipping -- file produced warnings (" + filename + "): " + JSON.stringify(aWarns));
            resolve("Skipping -- file produced warnings (" + filename + "): " + JSON.stringify(aWarns));
          }
        } else {
          console.log("Skipping -- not a JSON file (" + filename + ").");
          resolve("Skipping -- not a JSON file (" + filename + ").");
        }
      });
    });

    // 2 - second pass: process any relationships for the OpenIGC assets defined in the side-cars
    // (processing only the .igc files)
    const igcUpdatePromises = aFiles.map(function(filename) {
      return new Promise(function(resolve, reject) {

        if (path.extname(filename) === '.igc') {

          const sidecar = JSON.parse(fs.readFileSync(argv.directory + path.sep + filename, 'utf8'));

          const qGetSchemaRefs = {
            "types": [ "$JSON_Schema-JSchema", "$JSON_Schema-JSObject" ],
            "properties": [ "name", "$ref", "$id" ],
            "where": {
              "conditions": [{
                "property": "name",
                "operator": "=",
                "value": sidecar._schema.split('/').pop()
              }],
              "operator": "and"
            },
            "pageSize": 100
          };
        
          // Retrieve all OpenIGC JSON Schema objects whose name matches that of the
          // sidecar
          // NOTE: assumes that the object names do not overlap without actually pointing to
          // the same object (reference)!
          igcrest.search(qGetSchemaRefs).then(function(res) {
            igcrest.getAllPages(res.items, res.paging).then(function(allSchemaRefs) {
        
              const assetsToAssignToTerm = {
                "assigned_assets": {
                  "items": []
                }
              };
              for (let i = 0; i < allSchemaRefs.length; i++) {
                assetsToAssignToTerm.assigned_assets.items.push(allSchemaRefs[i]._id);
              }
              // Assign from term to all OpenIGC JSON Schema objects in one update
              igcrest.update(sidecar._id, assetsToAssignToTerm).then(function(success) {
                console.log("Successfully updated relationships for: " + filename);
                resolve("Successfully updated relationship for '" + filename + "' (from " + sidecar._id + "): " + JSON.stringify(success));
              }, function(failure) {
                console.log("ERROR: Update failed for '" + filename + "' -- " + failure);
                reject("ERROR: Update failed for '" + filename + "' -- " + failure);
              });
        
            });
          });

        } else {
          resolve("Skipping -- not a side-car file (" + filename + ").");
        }

      });
    });

    Promise.all(igcCreationPromises).then(function() {
      return Promise.all(igcUpdatePromises);
    }).then(function() {
      igcrest.closeSession().then(function() {
        console.log("All JSON schema information loaded from '" + argv.directory + "'.");
      }, function(failure) {
        console.log("All JSON schema information loaded from '" + argv.directory + "', but unable to close session: " + JSON.stringify(failure));
      });
    })
    .catch(console.error);

  });

});
