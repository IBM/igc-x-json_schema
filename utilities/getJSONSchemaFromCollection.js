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
 * @file Example automation to construct a JSON Schema file from a Physical Data Model in IGC
 * @license Apache-2.0
 * @requires ibm-iis-commons
 * @requires ibm-igc-rest
 * @requires fs-extra
 * @requires pretty-data
 * @requires uppercamelcase
 * @requires yargs
 * @requires prompt
 * @oaram n {string} - name of the collection from which to create a JSON Schema
 * @param f {string} - JSON file into which to extract IGC Terms structure
 * @example
 * // creates a JSON Schema in 'MySchema.json' from the Terms in collection 'MyCollection' (and default credentials file in ~/.infosvrauth)
 * ./getJSONSchemaFromCollection.js -n MyCollection -f MySchema.json
 */

const commons = require('ibm-iis-commons');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const igcrest = require('ibm-igc-rest');
const uppercamelcase = require('uppercamelcase');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -n <name> -f <path> -a <authfile> -p <password>')
    .option('n', {
      alias: 'name',
      describe: 'Collection name',
      demand: true, requiresArg: true, type: 'string'
    })
    .option('f', {
      alias: 'file',
      describe: 'JSON Schema output file',
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
const collectionName = argv.name;
const outputFile = argv.file;

const envCtx = new commons.EnvironmentContext(null, argv.authfile);

prompt.override = argv;

const hmObjectCache = {};

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
  igcrest.setConnection(envCtx.getRestConnection(result.password, 10));
  igcrest.disableThrowingErrors();

  // Opting for this approach rather than a search to handle collections within collections
  // (and make the Term translation through its type hierarchy a bit more generic)
  igcrest.getAssetsInCollection(collectionName, 1000, function(errCollection, resCollection) {

    if (errCollection !== null) {
      console.error("Unable to retrieve collection: " + errCollection);
    } else {
      console.log("Retrieving all objects from collection '" + collectionName + "'...");
      hmObjectCache[collectionName] = {
        type: "object",
        $schema: "http://json-schema.org/schema#",
        id: collectionName,
        title: collectionName,
        properties: {}
      };
      translateToJSONSchema(resCollection);
    }

  });

});

// Most of the work: the 'assets' is the set of assets within the collection
function translateToJSONSchema(assets) {

  console.log("... total objects found: " + assets.length);

  // First pass: check contents of the collection -- if there are any sub-collections, there should be 1 (and only 1) term
  console.log("Checking collection details...");
  let termCount = 0;
  let collectionCount = 0;
  let nameOfContainer = "";
  for (let i = 0; i < assets.length; i++) {
    if (assets[i]._type === "term") {
      termCount++;
      nameOfContainer = uppercamelcase(assets[i]._name);
    } else if (assets[i]._type === "collection") {
      collectionCount++;
    }
  }

  if (collectionCount > 0 && termCount !== 1) {
    console.error("ERROR: Found multiple collections, but not only a single term.");
  }

  console.log("Getting term details...");
  for (let i = 0; i < assets.length; i++) {
    if (assets[i]._type === "term") {
      getTermRelationships(assets[i]).then(function(response) {
        if (!hmObjectCache[collectionName].hasOwnProperty("properties")) {
          hmObjectCache[collectionName].properties = {};
        }
        addPropertiesToCache(response, hmObjectCache[collectionName].properties);
      }, function(error) {
        console.error(" ... failed: ", error);
      });
    } else if (assets[i]._type === "collection") {
      getSubObject(assets[i]).then(function(response) {
        if (!hmObjectCache[collectionName].hasOwnProperty("properties")) {
          hmObjectCache[collectionName].properties = {};
        }
        const subObjName = uppercamelcase(assets[i]._name);
        if (!hmObjectCache[collectionName].properties.hasOwnProperty(nameOfContainer)) {
          hmObjectCache[collectionName].properties[nameOfContainer] = {};
          hmObjectCache[collectionName].properties[nameOfContainer].properties = {};
        }
        if (!hmObjectCache[collectionName].properties[nameOfContainer].properties.hasOwnProperty(subObjName)) {
          hmObjectCache[collectionName].properties[nameOfContainer].properties[subObjName] = {};
          hmObjectCache[collectionName].properties[nameOfContainer].properties[subObjName].type = "object";
          hmObjectCache[collectionName].properties[nameOfContainer].properties[subObjName].properties = {};
        }
        translateToJSONSchema(response);
      }, function(error) {
        console.error(" ... failed: ", error);
      });
    }
  }

}

function getSubObject(collection) {

  console.log("Retrieving all object details from collection '" + collection._name + "'...");
  return new Promise(function(resolve, reject) {

    igcrest.getAssetsInCollection(collection._name, 1000, function(errCollection, resCollection) {
      if (errCollection) {
        reject(Error(errCollection));
      } else {
        resolve(resCollection);
      }
    });

  });

}

function getTermRelationships(term) {

  console.log("Retrieving all term details for term '" + term._name + "'...");
  return new Promise(function(resolve, reject) {

    const properties = [
      "name",
      "short_description",
      "custom_Data Class",
      "is_a_type_of",
      "has_types",
      "has_a",
      "is_of"
    ];

    igcrest.getAssetPropertiesById(term._id, "term", properties, 1000, true, function(err, res) {
      if (err !== null) {
        reject(Error(err));
      } else {
        resolve(res);
      }
    });

  });

}

function addPropertiesToCache(termDetails, cache) {

  const propertyName = uppercamelcase(termDetails._name);
  if (cache.hasOwnProperty(propertyName)) {
    console.warn("ERROR: Found the same name '" + propertyName + "' already present!");
  }
  cache[propertyName] = {};
  cache[propertyName].description = termDetails.short_description;
  if (termDetails.has_a.items.length === 0) {
    getDataTypeFromDataClasses(termDetails._name, termDetails["custom_Data Class"].items).then(function(response) {
      cache[propertyName].type = response;
      checkAndOutputSchema();
    }, function(error) {
      console.error(" ... failed: ", error);
    });
  } else {
    console.log(" ... object, recursing on has_a relationships (" + termDetails.has_a.items.length + ") ...");
    cache[propertyName].type = "object";
    if (!cache[propertyName].hasOwnProperty("properties")) {
      cache[propertyName].properties = {};
    }
    for (let i = 0; i < termDetails.has_a.items.length; i++) {
      getTermRelationships(termDetails.has_a.items[i]).then(function(response) {
        addPropertiesToCache(response, cache[propertyName].properties);
      }, function(error) {
        console.error(" ... failed: ", error);
      });
    }
  }

}

function getDataTypeFromDataClasses(termName, classes, cache) {

  console.log("Retrieving data type for term '" + termName + "'...");
  return new Promise(function(resolve, reject) {

    if (classes.length === 0) {
      console.log(" ... no data type found -- defaulting type to string...");
      resolve("string");
    } else {
      let type = "";
      for (let i = 0; i < classes.length; i++) {
        const properties = [
          "name",
          "data_type_filter_elements_enum"
        ];
        // If the type is not already super-generic (string), look for a data type
        if (type !== "string") {
          igcrest.getAssetPropertiesById(classes[i]._id, "data_class", properties, 1, false, function(err, res) {
            console.log(" ... found data type(s): " + res.data_type_filter_elements_enum);
            if (res.data_type_filter_elements_enum.length > 1) {
              // If the possible types are defined by an array with more than one value, it must be a string to cover all possibilities...
              type = "string";
            } else {
              type = res.data_type_filter_elements_enum[0];
            }
            console.log(" ... setting type = " + type);
            resolve(type);
          });
        }
      }
    }

  });

}

function checkAndOutputSchema() {

  console.log("Outputting schema...");
  const options = {
    "encoding": 'utf8',
    "mode": 0o644,
    "flag": 'w'
  };
  fs.writeFileSync(outputFile, pd.json(hmObjectCache), options);

}
