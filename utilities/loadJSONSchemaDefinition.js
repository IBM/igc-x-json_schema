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

const commons = require('ibm-iis-commons');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const igcrest = require('ibm-igc-rest');
const igcext = require('ibm-igc-extensions');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -f <path> -o <path> -a <authfile> -p <password>')
    .option('f', {
      alias: 'file',
      describe: 'JSON Schema file',
      demand: true, requiresArg: true, type: 'string'
    })
    .option('o', {
      alias: 'output',
      describe: 'XML output file',
      demand: false, requiresArg: true, type: 'string'
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
const outputFile = argv.output;

const bOutput = (outputFile !== undefined && outputFile !== "");

const envCtx = new commons.EnvironmentContext(null, argv.authfile);
if (bOutput) {
  argv.password = "unused";
}

prompt.override = argv;

// To keep generated IDs unique and retrievable
let id_gen = 0;
const hmObjectIdentitiesToIds = {};

const hmSchemaTypeToIGCType = {
  "object": "JSObject",
  "array": "JSArray",
  "string": "JSPrimitive",
  "integer": "JSPrimitive",
  "number": "JSPrimitive",
  "boolean": "JSPrimitive",
  "null": "JSPrimitive"
};

const aCommonAttrs = ['name', 'short_description', '$id', '$format', '$default', '$enum', '$readOnly', '$example', '$ref', '$xml_name', '$xml_namespace', '$xml_prefix', '$xml_attribute', '$xml_wrapped'];

const hmIGCTypeToKnownAttrs = {
  "JSObject": aCommonAttrs.concat(['$discriminator', '$maxProperties', '$minProperties', '$required']),
  "JSArray": aCommonAttrs.concat(['$maxItems', '$minItems', '$uniqueItems']),
  "JSPrimitive": aCommonAttrs.concat(['$type', '$multipleOf', '$maximum', '$exclusiveMaximum', '$minimum', '$exclusiveMinimum', '$maxLength', '$minLength', '$pattern'])
};

//hmIGCTypeToKnownAttrs.JSchema = hmIGCTypeToKnownAttrs.JSObject.concat(['$schema']);

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

const ah = new igcext.AssetHandler();

prompt.start();
prompt.get(inputPrompt, function (errPrompt, result) {
  igcrest.setConnection(envCtx.getRestConnection(result.password));

  // Read in the JSON Schema and create an empty flow document (to hold the asset instances)
  const schema = fs.readFileSync(inputFile, 'utf8');
  
  // Translate the JSON Schema into IGC assets (the real work...)
  translateToIGCAssets(schema);

  // Invoke the REST API with the customised flow document XML
  const xmlAssets = ah.getCustomisedXML();

  if (bOutput) {
    const options = {
      "encoding": 'utf8',
      "mode": 0o644,
      "flag": 'w'
    };
    fs.writeFileSync(outputFile, pd.xml(xmlAssets), options);
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

// Helper functions to generate unique IDs and keep them retrievable later in processing
function mapObjectToNextId(identity) {
  id_gen++;
  const internalId = "xt" + id_gen;
  hmObjectIdentitiesToIds[identity] = internalId;
  return internalId;
}
/*function getIdForObjectIdentity(identity) {
  return hmObjectIdentitiesToIds[identity];
}*/

// Most of the work: the 'schema' is the JSON schema (as a string)
function translateToIGCAssets(schema) {
  
  const jsSchema = JSON.parse(schema);

  const assetObj = {};

  const aKeys = Object.keys(jsSchema);
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (jsSchema.hasOwnProperty(key)) {
      if (key === '$schema') {
        assetObj.$schema = jsSchema[key];
      } else if (key === 'id') {
        assetObj.$id = jsSchema[key];
      } else if (key === 'description') {
        if (jsSchema[key].length > 255) {
          assetObj.short_description = jsSchema[key].substring(0,251) + "...";
          assetObj.long_description  = jsSchema[key];
        } else {
          assetObj.short_description = jsSchema[key];
        }
      } else if (key === 'title') {
        assetObj.name = jsSchema[key];
      } else if (key === 'type') {
        assetObj.$type = jsSchema[key];
      } else if (key === 'enum') {
        assetObj.$enum = JSON.parse(JSON.stringify(jsSchema[key]));
      } else if (key !== 'properties') {
        console.log(" ... found unexpected schema-level key: " + key);
      }
    }
  }

  const schemaId = mapObjectToNextId(assetObj.$id);
  ah.addAsset('$JSON_Schema-JSchema', assetObj.name, schemaId, assetObj);

  if (jsSchema.hasOwnProperty('properties')) {
    translateProperties(jsSchema.properties, '#/properties', 'JSchema', schemaId);
  }

  ah.addImportAction([schemaId], []);

}

function translateProperties(properties, parentPath, parentType, parentId) {

  const aTitles = Object.keys(properties);
  for (let i = 0; i < aTitles.length; i++) {
    const title = aTitles[i];
    if (properties.hasOwnProperty(title)) {
      translatePropertyKeys(title, parentPath, properties[title], parentType, parentId);
    }
  }

}

function translatePropertyKeys(title, parentPath, propertyObj, parentType, parentId) {

  // Cannot expect titles to be globally unique -- only unique within the context of the full property hierarchy (path)
  const path = parentPath + "/" + title;
  const propertyId = mapObjectToNextId(path);
  let propertyTypeIGC = "";
  if (propertyObj.hasOwnProperty('type')) {
    propertyTypeIGC = hmSchemaTypeToIGCType[propertyObj.type];
  } else if (propertyObj.hasOwnProperty('$ref')) {
    propertyTypeIGC = "JSObject";
  }
  const assetObj = {};
  assetObj.$id = path;

  const aKeys = Object.keys(propertyObj);
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (propertyObj.hasOwnProperty(key)) {
      if (key === 'description') {
        if (propertyObj.description.length > 255) {
          assetObj.short_description = propertyObj.description.substring(0,251) + "...";
          assetObj.long_description  = propertyObj.description;
        } else {
          assetObj.short_description = propertyObj.description;
        }
      } else if (key !== 'properties' && key !== 'title' && key !== 'items') {
        if (key === 'example') {
          assetObj.$example = pd.json(JSON.stringify(propertyObj[key]));
        } else if (key === 'xml') {
          addXMLDetailsToAsset(propertyObj[key], assetObj);
        } else if (hmIGCTypeToKnownAttrs[propertyTypeIGC].indexOf('$' + key) !== -1) {
          assetObj['$' + key] = propertyObj[key];
        } else if (key === '$ref') {
          assetObj[key] = propertyObj[key];
        } else if (key !== 'type') {
          console.log(" ... found unhandled property (of '" + path + "'): " + key);
        }
      }
    }
  }

  ah.addAsset('$JSON_Schema-' + propertyTypeIGC, title, propertyId, assetObj, '$' + parentType, parentId);

  if (propertyObj.hasOwnProperty('properties')) {
    translateProperties(propertyObj.properties, path + "/properties", propertyTypeIGC, propertyId);
  }
  if (propertyObj.hasOwnProperty('items')) {
    translateArrayItems(propertyObj.items, path, propertyTypeIGC, propertyId);
  }

}

function translateArrayItems(items, parentPath, parentType, parentId) {

  const path = parentPath + "/items";
  const itemId = mapObjectToNextId(path);
  const assetObj = {};

  let arrayItemTypeIGC = "JSPrimitive";

  const aKeys = Object.keys(items);
  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (items.hasOwnProperty(key)) {
      if (key === 'type') {
        arrayItemTypeIGC = hmSchemaTypeToIGCType[items.type];
      } else if (key === '$ref') {
        assetObj.$ref = items.$ref;
        arrayItemTypeIGC = "JSObject";
      } else if (key !== 'type') {
        console.log(" ... found unhandled array item type: " + key);
      }
    }
  }

  ah.addAsset("$JSON_Schema-" + arrayItemTypeIGC, "items", itemId, assetObj, '$' + parentType, parentId);

}

function addXMLDetailsToAsset(xmlDetails, assetObj) {

  const xmlKeys = Object.keys(xmlDetails);
  for (let i = 0; i < xmlKeys.length; i++) {
    const key = xmlKeys[i];
    assetObj['$xml_' + key] = xmlDetails[key];
  }

}
