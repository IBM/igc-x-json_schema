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
    .option('f', {
      alias: 'file',
      describe: 'JSON Schema file',
      demand: true, requiresArg: true, type: 'string'
    })
    .option('a', {
      alias: 'authfile',
      describe: 'Authorisation file containing environment context',
      requiresArg: true, type: 'string'
    })
    .option('p', {
      alias: 'password',
      describe: 'Password for invoking REST API',
      demand: false, requiresArg: true, type: 'string'
    })
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const inputFile = argv.file;

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
  const schema = JSON.parse(fs.readFileSync(inputFile, 'utf8'));

  const qGetAllJSONSchemaObjects = {
    "pageSize": "100",
    "properties": [ "name", "$ref", "$id" ],
    "types": [ "$JSON_Schema-JSPrimitive", "$JSON_Schema-JSObject" ]
  };

  igcrest.search(qGetAllJSONSchemaObjects, function(err, resSearch) {

    igcrest.getAllPages(resSearch.items, resSearch.paging, function(errAll, allResults) {

      if (errAll !== null) {
        console.log("ERROR: Unable to retrieve all JSON Schema elements - " + errAll);
      } else {

        console.log("Total elements found: " + allResults.length);
        cacheAllJSONDetails(schema, "#/definitions");
        mapIGCDetailsIntoCache(allResults);
        for (let j = 0; j < allResults.length; j++) {
          const item = allResults[j];
          const id = item.$id;
          console.log("Handling " + id);
          const detailsFromJSON = hmJSONIdToDetails[id];
          let updates = {};
          if (item.$ref !== "") {
            updates = findRelatedObjectsByRef(updates, item._id, item.$ref);
          }
          if (typeof detailsFromJSON !== 'undefined' && detailsFromJSON !== null) {
            if (detailsFromJSON.hasOwnProperty("x-ibm-igc-assigned-terms")) {
              updates = assignToTerms(updates, item._id, detailsFromJSON["x-ibm-igc-assigned-terms"]);
            }
            if (detailsFromJSON.hasOwnProperty("x-ibm-igc-rid")) {
              updates = linkToOriginatingAsset(updates, item._id, detailsFromJSON["x-ibm-igc-rid"]);
            }
          }
          console.log(" ... consolidated updates: " + JSON.stringify(updates));
          igcrest.update(item._id, updates, handleAnyUpdateError);
        }

      }

    });

  });

});

// Reverse-map a cache from JSON $id to details
function cacheAllJSONDetails(schema, parentPath) {

  const definitions = schema.properties;
  const objectNames = Object.keys(definitions);
  for (let i = 0; i < objectNames.length; i++) {
    const objName = objectNames[i];
    if (definitions.hasOwnProperty(objName)) {
      const obj = definitions[objName];
      const id  = parentPath + "/" + objName;
      hmJSONIdToDetails[id] = obj;
      if (obj.hasOwnProperty("properties")) {
        cacheAllJSONDetails(obj, id + "/properties");
      }
    }
  }

}

// Add a RID into the JSON cache details
function mapIGCDetailsIntoCache(igcResults) {

  for (let i = 0; i < igcResults.length; i++) {
    const rid = igcResults[i]._id;
    const id  = igcResults[i].$id;
    console.log("Mapping into: " + id);
    hmJSONIdToDetails[id]._rid = rid;
  }

}

// Will search for any related JSON Schema or JSON Schema Object with an ID equivalent to 
// the provided reference, and return a single RID for any such object found
function findRelatedObjectsByRef(update, fromRID, ref) {

  const toRID = hmJSONIdToDetails[ref]._rid;
  update.custom_Uses = {
    "items": [ toRID ]
  };
  return update;

}

function assignToTerms(update, fromRID, toRIDs) {

  if (toRIDs.length > 0) {
    console.log(" ... will assign " + fromRID + " to term(s) " + toRIDs);
    update.assigned_to_terms = {
      "items": toRIDs
    };
  }
  return update;

}

function linkToOriginatingAsset(update, fromRID, toRID) {

  console.log(" ... will assign " + fromRID + " to original asset " + toRID);
  update.custom_Implements = {
    "items": [ toRID ]
  };
  return update;

}

function handleAnyUpdateError(err, resUpdate) {
  if (err !== null) {
    console.log("ERROR: Update failed -- " + err);
  } else {
    console.log("Successfully updated relationship: " + resUpdate);
  }
}
