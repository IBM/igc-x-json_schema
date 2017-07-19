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
 * @requires n {string} - name of the PDM from which to create a JSON Schema
 * @param f {string} - JSON file into which to extract IGC Physical Data Model
 * @example
 * // creates a JSON Schema in 'MySchema.json' from the Physical Data Model named 'MyPDM' (and default credentials file in ~/.infosvrauth)
 * ./getJSONSchemaFromPDM.js -n MyPDM -f MySchema.json
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
      describe: 'PDM name',
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
const pdmName = argv.name;
const outputFile = argv.file;

const envCtx = new commons.EnvironmentContext(null, argv.authfile);

prompt.override = argv;

const hmColumnToTable = {};
const hmTableDetails = {};

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

  // Note: not possible to restrict by PDM name here because 'design_table_or_view' is a datagroup, no explicit 'physical_data_model' property on it
  // to use for restricting the search...
  // BEWARE:
  // Known issue (JR58057) -- fixed in 11.5.0.2_sp1 (RUP8) -- means paging does not work properly when a "where" clause is included (the same results just get repeated on every page)
  //                       -- if using earlier version, remove the "where" clause or set the pageSize to be larger than the number of results
  // (For prototype simplicity, opting to retrieve all, so we can also lookup key relationships more easily even where business terms may not be assigned)
  const pdmQuery = {
    "properties": [
      "name",
      "data_type",
      "length",
      "minimum_length",
      "allows_null_values",
//      "parent_design_foreignKey",
//      "included_in_design_foreign_key",
      "included_in_design_foreign_key.referenced_by_design_column",
      "assigned_to_terms",
      "design_table_or_view.assigned_to_terms"
    ],
    "types": ["design_column"],
/*    "where": {
      "operator": "and",
      "conditions": [
        {
          "property": "assigned_to_terms",
          "operator": "isNull",
          "negated": true
        }
      ]
    }, */
    "pageSize": "100"
  };

  igcrest.search(pdmQuery, function(err, resSearch) {

    if (err !== null) {
      console.error("Search failed: " + err);
    } else {
      console.log("Retrieving all design columns from the environment...");
      igcrest.getAllPages(resSearch.items, resSearch.paging, function(err, allResults) {

        const schema = translateToJSONSchema(allResults);
        const options = {
          "encoding": 'utf8',
          "mode": 0o644,
          "flag": 'w'
        };
        fs.writeFileSync(outputFile, pd.json(schema), options);

      });
    }

  });

});

// Most of the work: the 'searchResults' is a set of design_column search results
function translateToJSONSchema(designColumns) {

  const schema = {
    type: "object",
    $schema: "http://json-schema.org/schema#",
    id: pdmName,
    title: pdmName,
    properties: {}
  };

  console.log("... total columns found: " + designColumns.length);

  // First pass: get a mapping of columns to tables (tables need to be created first as higher-level objects)
  console.log("Mapping columns to tables...");
  for (let i = 0; i < designColumns.length; i++) {
    mapColumnsToTables(designColumns[i]);
  }
  console.log("... complete.");

  // ... then setup the tabls as objects in the schema
  console.log("Creating tables as embedded objects in the schema...");
  const aTables = Object.keys(hmTableDetails);
  for (let i = 0; i < aTables.length; i++) {

    const tblObj = hmTableDetails[ aTables[i] ];
    const tblDetails = translateTableToObject(tblObj);

    schema.properties[tblDetails.title] = {
      "x-ibm-igc-rid": tblObj._id,
      "x-ibm-igc-assigned-terms": tblDetails.assigned_term_rids,
      type: "object",
      properties: {}
    };

  }
  console.log("... complete.");

  // Second pass: create the columns as "properties" embedded within the table objects
  console.log("Creating columns as properties within the tables...");
  for (let i = 0; i < designColumns.length; i++) {

    const colRID = designColumns[i]._id;
    const tblName = getNameForObject(hmTableDetails[ hmColumnToTable[colRID] ]);
    const colDetails = translateColumnToProperty(designColumns[i]);
    
    // The basic characteristics
    schema.properties[tblName].properties[colDetails.title] = {
      "x-ibm-igc-rid": colRID,
      "x-ibm-igc-assigned-terms": colDetails.assigned_term_rids
    };

    // Translate any relationships to $ref first
    // -- if there are any, there should not be any 'type', etc information
    if (colDetails.hasOwnProperty("related_tables")) {
      
      const aTblRIDs = Object.keys(colDetails.related_tables);
      for (let x = 0; x < aTblRIDs.length; x++) {
        const tblRID = aTblRIDs[x];
        if (colDetails.related_tables.hasOwnProperty(tblRID)) {
          const tblDetails = translateTableToObject(colDetails.related_tables[tblRID]);
          schema.properties[tblName].properties[colDetails.title].$ref = "#/definitions/" + tblDetails.title;
        }
      }

    } else {

      // Any remaining basic characteristics
      schema.properties[tblName].properties[colDetails.title].length = colDetails.length;

      // Translate the type to JSON Schema
      addTypeToJSONSchema(schema.properties[tblName].properties[colDetails.title], colDetails.type);

    }

    // Add any required fields to the 'required' array
    if (colDetails.required) {
      if (!schema.properties[tblName].hasOwnProperty("required")) {
        schema.properties[tblName].required = [];
      }
      schema.properties[tblName].required.push(colDetails.title);
    }

  }
  console.log("... complete.");

  return schema;

}

// Setup a reverse-map from column RID to containing table RID
// Also build up a cache of any table details we discover from the column's contextual information
function mapColumnsToTables(column) {

  const colRID = column._id;

  let tblRID = null;
  const tblDetails = {};
  for (let j = 0; j < column._context.length; j++) {
    if (column._context[j]._type === 'design_table' || column._context[j]._type === 'design_view') {
      tblRID = column._context[j]._id;
      tblDetails._name = column._context[j]._name;
      tblDetails._id = column._context[j]._id;
      tblDetails._type = column._context[j]._type;
    }
  }
  hmColumnToTable[colRID] = tblRID;

  if (!hmTableDetails.hasOwnProperty(tblRID)) {
    tblDetails.assigned_to_terms = column["design_table_or_view.assigned_to_terms"];
    hmTableDetails[tblRID] = tblDetails;
  }

}

// Turn an IGC 'design_table' object into something more easily JSON Schema-interpretable
function translateTableToObject(table) {

  const jsonTbl = {};

  jsonTbl.title = getNameForObject(table);
  jsonTbl.assigned_term_rids = [];
  for (let k = 0; k < table.assigned_to_terms.items.length; k++) {
    const assignedTermRID = table.assigned_to_terms.items[k]._id;
    jsonTbl.assigned_term_rids.push(assignedTermRID);
  }

  return jsonTbl;

}

// Turn an IGC 'design_column' object into something more easily JSON Schema-interpretable
function translateColumnToProperty(column) {

  const jsonCol = {};

  jsonCol.title = getNameForObject(column);
  jsonCol.type = column.data_type;
  jsonCol.length = column.length;
  jsonCol.required = !column.allows_null_values;
  jsonCol.assigned_term_rids = [];
  for (let k = 0; k < column.assigned_to_terms.items.length; k++) {
    const assignedTermRID = column.assigned_to_terms.items[k]._id;
    jsonCol.assigned_term_rids.push(assignedTermRID);
  }

  // Draft attempt at determining $ref inputs from foreign key information
  if (column.hasOwnProperty("included_in_design_foreign_key.referenced_by_design_column") && column["included_in_design_foreign_key.referenced_by_design_column"].items.length > 0) {
    jsonCol.related_tables = {};
    for (let l = 0; l < column["included_in_design_foreign_key.referenced_by_design_column"].items.length; l++) {
      const relatedColRID = column["included_in_design_foreign_key.referenced_by_design_column"].items[l]._id;
      const relatedTblRID = hmColumnToTable[relatedColRID];
      jsonCol.related_tables[relatedTblRID] = hmTableDetails[relatedTblRID];
    }
  }

  return jsonCol;

}

// Translate the name of any object (table or column)
// 1. Using the first assigned business term
// 2. If none, using the name of the object itself
// 3. In either case, switching the name to UpperCamelCase
function getNameForObject(obj) {

  let name = obj._name;
  if (obj.hasOwnProperty("assigned_to_terms")) {
    if (obj.assigned_to_terms.items.length > 1) {
      // TODO: more logic in case there are multiple terms?
      console.log("WARNING: More than one term assignment found (" + obj._name + ")!  Only taking the first for simplicity...");
      name = obj.assigned_to_terms.items[0]._name;
    } else if (obj.assigned_to_terms.items.length === 1) {
      name = obj.assigned_to_terms.items[0]._name;
    }
  }
  return uppercamelcase(name);

}

// Convert from an IGC 'data_type' into a JSON Schema type & format
function addTypeToJSONSchema(objToAddTo, igcType) {
  switch (igcType) {
    case 'INT8':
      objToAddTo.type = "integer";
      objToAddTo.format = "int8";
      break; 
    case 'INT16':
      objToAddTo.type = "integer";
      objToAddTo.format = "int16";
      break;
    case 'INT32':
      objToAddTo.type = "integer";
      objToAddTo.format = "int32";
      break;
    case 'INT64':
      objToAddTo.type = "integer";
      objToAddTo.format = "int64";
      break;
    case 'SFLOAT':
    case 'DFLOAT':
    case 'QFLOAT':
      objToAddTo.type = "number";
      objToAddTo.format = "float";
      break;
    case 'DECIMAL':
      objToAddTo.type = "number";
      objToAddTo.format = "double";
      break;
    case 'BOOLEAN':
      objToAddTo.type = "boolean";
      break;
    case 'DATE':
      objToAddTo.type = "string";
      objToAddTo.format = "date";
      break;
    case 'DATETIME':
      objToAddTo.type = "string";
      objToAddTo.format = "date-time";
      break;
    default:                      // handles STRING, BINARY, TIME, DURATION, CHOICE, ORDERED_GROUP, UNORDERED_GROUP, GUID, UNKNOWN, JSON, XML
      objToAddTo.type = "string";
  }
}
