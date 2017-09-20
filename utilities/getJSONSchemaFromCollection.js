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
const rootCollectionName = argv.name;
const outputFile = argv.file;

const envCtx = new commons.EnvironmentContext(null, argv.authfile);

prompt.override = argv;

const jsonSchema = {};
const hmDataClassToType = {};

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

  console.log("Retrieving all object details from collection '" + rootCollectionName + "'...");
  igcrest.getAssetsInCollection(rootCollectionName, 1000).then(function(assets) {
  
    // Start by getting the name of the single term within the collection -- this should
    // actually be the name of the top-level schema (not the collection)
    console.log("Checking collection details...");
    let termCount = 0;
    let collectionCount = 0;
    let rootSchemaName = "";
    let rootTerm = null;
    for (let i = 0; i < assets.length; i++) {
      if (assets[i]._type === "term") {
        termCount++;
        rootSchemaName = uppercamelcase(assets[i]._name);
        rootTerm = assets[i];
      } else if (assets[i]._type === "collection") {
        collectionCount++;
      }
    }
  
    if (collectionCount > 0 && termCount !== 1) {
      console.error("ERROR: Found one or more sub-collections, but not only a single term -- the root collection must have only a single term.");
      process.exit(1);
    }

    createSchemaForTerm(rootTerm);

    // The rest need only handle collections (root object's single term handled above)
    for (let i = 0; i < assets.length; i++) {
      if (assets[i]._type === "collection") {
        processNestedCollection(assets[i], jsonSchema[rootSchemaName].properties);
      }
    }
  
  });

});

function processNestedCollection(collection, nestedInSchema) {
  
  const collectionName = collection._name;
  
  // For nested collections, we should create references to new root-level schema objects
  // First we'll create the references placeholder
  const referenceName = uppercamelcase(collectionName);
  if (!nestedInSchema.hasOwnProperty(referenceName)) {
    nestedInSchema[referenceName] = {};
    nestedInSchema[referenceName].type = "object";
    nestedInSchema[referenceName].oneOf = [];
  }

  // Then we'll create the root-level schema objects themselves (for any terms),
  // and pass along the references placeholder for populating
  console.log("Retrieving all object details from collection '" + collectionName + "'...");
  igcrest.getAssetsInCollection(collectionName, 1000).then(function(assets) {

    for (let i = 0; i < assets.length; i++) {
      if (assets[i]._type === "term") {
        createSchemaForTerm(assets[i]);
        const jsonName = uppercamelcase(assets[i]._name);
        nestedInSchema[referenceName].oneOf.push({ "$ref": "#/definitions/" + jsonName });
      } else if (assets[i]._type === "collection") {
        console.log("Flattening embedded collection '" + assets[i]._name + "' into outer object...");
        processNestedCollection(assets[i], nestedInSchema);
      }
    }

  });

}

function createSchemaForTerm(term) {

  const jsonName = uppercamelcase(term._name);
  if (!jsonSchema.hasOwnProperty(jsonName)) {
    jsonSchema[jsonName] = {
      type: "object",
      $schema: "http://json-schema.org/schema#",
      id: jsonName,
      title: jsonName,
      properties: {}
    };
    getTermRelationships(term).then(function(response) {
      addPropertiesToSchema(response, jsonSchema[jsonName]);
    }, _logError);
  }

}

function _logError(error) {
  console.error(" ... failed: ", error);
}

function getTermRelationships(term) {

  console.log("Retrieving all term details for term '" + term._name + "'...");
  const properties = [
    "name",
    "short_description",
    "custom_Data Class",
    "is_a_type_of",
    "has_types",
    "has_a",
    "is_of"
  ];

  return igcrest.getAssetPropertiesById(term._id, "term", properties, 1000, true);

}

function addPropertiesToSchema(termDetails, schema) {

  schema.description = termDetails.short_description;

  if (termDetails.has_a.items.length === 0) {
    getDataTypeFromDataClasses(termDetails._name, termDetails["custom_Data Class"].items).then(function(response) {
      schema.type = response;
      delete schema.properties;
      checkAndOutputSchema();
    }, _logError);
  } else {
    let bInfiniteRecursion = false;
    for (let i = 0; i < termDetails.has_a.items.length && !bInfiniteRecursion; i++) {
      const hasaTerm = termDetails.has_a.items[i];
      bInfiniteRecursion = (hasaTerm._id === termDetails._id);
    }
    if (bInfiniteRecursion) {
      console.log(" ... object embeds itself (infinite recursion) -- skipping: " + termDetails._name);
      // TODO: trace down data class still -- don't just hard-code to string?
      schema.type = "string";
      delete schema.properties;
    } else {
      for (let i = 0; i < termDetails.has_a.items.length; i++) {
        getTermRelationships(termDetails.has_a.items[i]).then(function(response) {
          addPropertiesToObject(response, schema.properties);
        }, _logError);
      }
    }
  }

}

function addPropertiesToObject(termDetails, schema) {

  const propertyName = uppercamelcase(termDetails._name);
  if (schema.hasOwnProperty(propertyName)) {
    console.warn("ERROR: Found the same name '" + propertyName + "' already present!");
  }
  schema[propertyName] = {};
  schema[propertyName].description = termDetails.short_description;
  if (termDetails.has_a.items.length === 0) {
    getDataTypeFromDataClasses(termDetails._name, termDetails["custom_Data Class"].items).then(function(response) {
      schema[propertyName].type = response;
      checkAndOutputSchema();
    }, _logError);
  } else {
    console.log(" ... object, recursing on has_a relationships (" + termDetails.has_a.items.length + ") ...");
    schema[propertyName].type = "object";
    if (!schema[propertyName].hasOwnProperty("properties")) {
      schema[propertyName].properties = {};
    }
    let bInfiniteRecursion = false;
    for (let i = 0; i < termDetails.has_a.items.length && !bInfiniteRecursion; i++) {
      const hasaTerm = termDetails.has_a.items[i];
      bInfiniteRecursion = (hasaTerm._id === termDetails._id);
    }
    if (bInfiniteRecursion) {
      console.log(" ... object embeds itself (infinite recursion) -- skipping: " + termDetails._name);
      // TODO: trace down data class still -- don't just hard-code to string?
      schema[propertyName].type = "string";
      delete schema[propertyName].properties;
    } else {
      for (let i = 0; i < termDetails.has_a.items.length; i++) {
        getTermRelationships(termDetails.has_a.items[i]).then(function(response) {
          addPropertiesToObject(response, schema[propertyName].properties);
        }, _logError);
      }
    }
  }

}

function getDataTypeFromDataClasses(termName, classes) {

  console.log("Retrieving data type for term '" + termName + "'...");
  return new Promise(function(resolve, reject) {

    if (classes.length === 0) {
      console.log(" ... no data type found -- defaulting type to string...");
      resolve("string");
    } else {
      let type = "";
      for (let i = 0; i < classes.length; i++) {
        const classId = classes[i]._id;
        // If the type is already super-generic (string), just resolve straight away
        if (type === "string") {
          resolve("string");
        } else {
          // If we've looked it up before, just use the cached type -- don't look it up again
          if (hmDataClassToType.hasOwnProperty(classId)) {
            type = hmDataClassToType[classId];
          } else {
            // If the type is not already cached, look for a data type
            const properties = [
              "name",
              "data_type_filter_elements_enum"
            ];
            igcrest.getAssetPropertiesById(classId, "data_class", properties, 1, false).then(function(res) {
              console.log(" ... found data type(s): " + res.data_type_filter_elements_enum);
              if (res.data_type_filter_elements_enum.length > 1) {
                // If the possible types are defined by an array with more than one value, it must be a string to cover all possibilities...
                type = "string";
              } else {
                type = res.data_type_filter_elements_enum[0];
              }
              hmDataClassToType[classId] = type;
              console.log(" ... setting (and caching) type = " + type);
              resolve(type);
            }, function(err) {
              reject(Error(err));
            });
          }
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
  fs.writeFileSync(outputFile, pd.json(jsonSchema), options);

}
