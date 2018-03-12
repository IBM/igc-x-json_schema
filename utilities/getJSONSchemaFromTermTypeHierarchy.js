#!/usr/bin/env node

/***
 * Copyright 2018 IBM Corp. All Rights Reserved.
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
 * @file Example automation to construct JSON Schema files from the Term Type Hierarchy in IGC
 * @license Apache-2.0
 * @requires ibm-iis-commons
 * @requires ibm-igc-rest
 * @requires fs-extra
 * @requires pretty-data
 * @requires uppercamelcase
 * @requires yargs
 * @requires prompt
 * @param d {string} - directory into which to place the extracted JSON Schema files
 * @example
 * // creates JSON Schema files in '/tmp/schemas' (using default credentials file in ~/.infosvrauth)
 * ./getJSONSchemaFromTermTypeHierarchy.js -d /tmp/schemas
 */

const commons = require('ibm-iis-commons');
const path = require('path');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const igcrest = require('ibm-igc-rest');
const uppercamelcase = require('uppercamelcase');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -d <path> -a <authfile> -p <password> -n <namespace>')
    .example('$0 -d /tmp/schemas -n "http://company.com/#"', 'creates JSON Schema files in "/tmp/schemas" and qualifying all schema ids with "http://company.com/#" (using default credentials file in ~/.infosvrauth)')
    .alias('d', 'directory').nargs('d', 1).describe('d', 'JSON Schema output directory')
    .alias('a', 'authfile').nargs('a', 1).describe('a', 'Authorisation file containing environment context')
    .alias('p', 'password').nargs('p', 1).describe('p', 'Password for invoking REST API')
    .alias('n', 'namespace').nargs('n', 1).describe('n', 'Unique namespaces to use for qualifying schema id')
    .alias('l', 'limit').nargs('l', 1).describe('l', 'Limit terms to those within a specific category (provide RID)')
    .demandOption(['d','n'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const envCtx = new commons.EnvironmentContext(null, argv.authfile);

prompt.override = argv;

const maxRelatedTerms = 1000;
const cardinalityCA = "custom_Can be Multiple";
const hmRidToObject = {};
const hmProcessedRIDs = {};
const hmNameClashCheck = {};
const hmTermToType = {};

const termProperties = [
  "name",
  "category_path",
  "short_description",
  "long_description",
  "has_types",
  "is_of",
  "has_a",
  "assigned_terms",
  "assigned_to_terms",
  cardinalityCA
];

// All the terms that
// - have at least one "assigned terms" relationships to other terms
// are relationship bridges
const aRelationTerms = [];

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

  console.log("1 - cache all data classes...");
  igcrest.search({"properties":["name","data_type_filter_elements_enum","assigned_to_terms"],"types":["data_class"],"pageSize":100}).then(function(dc) {

    igcrest.getAllPages(dc.items, dc.paging).then(function(allDCs) {
      for (let i = 0; i < allDCs.length; i++) {
        // get data type from data class definition
        const types = allDCs[i].data_type_filter_elements_enum;
        for (let j = 0; j < allDCs[i].assigned_to_terms.length; j++) {
          // a term could be assigned multiple data classes, so we need to
          // check and merge data types that might have previously been set
          const ridTerm = allDCs[i].assigned_to_terms[j]._id;
          if (hmTermToType.hasOwnProperty(ridTerm)) {
            hmTermToType[ridTerm] = mergeTypes(types.push(hmTermToType[ridTerm]));
          } else {
            hmTermToType[ridTerm] = mergeTypes(types);
          }
        }
      }

      let qTerms = {
        "properties": termProperties,
        "types": ["term"],
        "pageSize": 100
      }
      if (argv.limit !== null && argv.limit !== "") {
        qTerms.where = {
          "conditions": [{
            "property": "category_path._id",
            "operator": "=",
            "value": argv.limit
          }],
          "operator": "and"
        };
        console.log("2 - get all terms within category " + argv.limit + "...");
      } else {
        console.log("2 - get all terms...");
      }
      igcrest.search(qTerms).then(function(res) {

        igcrest.getAllPages(res.items, res.paging).then(function(allTerms) {
          console.log("  a) cache rids-to-names, leaves, and relations");
          for (let i = 0; i < allTerms.length; i++) {
            const path = getDefnPathFromCategoryPath(allTerms[i].category_path);
            const rid  = allTerms[i]._id;
            const name = formatNameForJSON(allTerms[i]._name);
            hmRidToObject[rid] = allTerms[i];
            hmRidToObject[rid].jsonSchemaId = argv.namespace + path + "/" + name;
            // TODO: confirm how we distinguish terms that purely define relationships
            // rather than some form of object / containment (or keep these as entirely
            // independent objects and don't handle them in any special way?)
            if (allTerms[i].assigned_terms.items.length > 0) {
              aRelationTerms.push(rid);
            }
          }
          const aTerms = Object.keys(hmRidToObject);
          console.log("     total terms found = " + aTerms.length);
          console.log("     rel'n terms found = " + aRelationTerms.length);
          console.log("  b) process all non-relationship terms");
          for (let i = 0; i < aTerms.length; i++) {
            const rid = aTerms[i];
            defineSchemaForTerm(hmRidToObject[rid]);
          }
          console.log("  c) add the relations");
          for (let i = 0; i < aRelationTerms.length; i++) {
            linkTermsViaRelation(hmRidToObject[ aRelationTerms[i] ]);
          }

        });
      });

    });
  });

});

// Simple merge logic: if different types are defined,
// go with lowest-common denominator => string
function mergeTypes(typeArray) {
  let type = "string";
  if (typeArray.every(elementTheSame)) {
    // If all the types are the same just take the first one;
    // in any other scenario we need to use 'string' to be appropriately generic
    type = typeArray[0];
  }
  return type;
}

function elementTheSame(element, index, array) {
  return (element === array[0]);
}

function getTermRefFromCache(rid) {
  if (hmRidToObject.hasOwnProperty(rid)) {
    return hmRidToObject[rid].jsonSchemaId;
  } else {
    return null;
  }
}

function getTermDetails(rid) {

  if (!hmProcessedRIDs.hasOwnProperty(rid)) {
    defineSchemaForTerm(hmRidToObject[rid]);
  }

}

function defineSchemaForTerm(term) {
  
  const schema = {
    "id": argv.namespace,
    "$schema": "http://json-schema.org/draft-06/schema#"
  };

  const path = getDefnPathFromCategoryPath(term.category_path);
  const rid  = term._id;
  const name = formatNameForJSON(term._name);

  // Skip duplicate processing
  if (!hmProcessedRIDs.hasOwnProperty(rid)) {

    schema.id = schema.id + path + "/" + name;
    schema.description = getSingularDescription(term);

    if (hmNameClashCheck.hasOwnProperty(name)) {
      console.log("WARNING: found non-unique term name --> " + name + " <-- while processing schema " + path + "/" + name + " (" + rid + ")");
    }
    hmNameClashCheck[name] = true;
    hmProcessedRIDs[rid] = true;
  
    // Type determination
    if (term.has_a.items.length > 0) {
      // if it has "has a" relationships, it's an object
      // (note that there could be both "has a" and "has types", but we assume this 
      //  will only ever be the case on generic / abstract objects, and the "object"
      //  overrides the enumeration [the enumeration will be explicit in the more
      //  detailed objects that get created for each type])
      schema.type = "object"
      schema.properties = {};
      for (let i = 0; i < term.has_a.items.length; i++) {
        const rRid  = term.has_a.items[i]._id;
        const rName = formatNameForJSON(term.has_a.items[i]._name);
        const rObj  = hmRidToObject[rRid];
        if (rObj.hasOwnProperty(cardinalityCA)
            && rObj[cardinalityCA] === "yes") {
          schema.properties[rName] = {
            "type": "array",
            "items": {
              "$ref": getTermRefFromCache(rRid)
            }
          };
        } else {
          schema.properties[rName] = { "$ref": getTermRefFromCache(rRid) };
        }
      }
    } else if (term.has_types.items.length > 0) {
      // if it "has types" then it is an enum
      schema.enum = [];
      for (let i = 0; i < term.has_types.items.length; i++) {
        schema.enum.push(term.has_types.items[i]._name);
      }
    } else {
      // otherwise, determine the simple data type
      if (hmTermToType.hasOwnProperty(rid)) {
        setJSONSchemaTypeFromIGCType(schema, hmTermToType[rid]);
      } else {
        // catch-all -- in case it has not been associated with
        // a data class, it will default to "string" as lowest common denominator
        setJSONSchemaTypeFromIGCType(schema, "string");
      }
    }
  
/*    // TODO: [ "assigned_terms", "assigned_to_terms" ]
    if (term.assigned_to_terms.items.length > 0) {
      for (let i = 0; i < term.assigned_to_terms.items.length; i++) {
        const rid  = term.assigned_to_terms.items[i]._id;
        const name = formatNameForJSON(term.assigned_to_terms.items[i]._name);
        schema.properties[name] = {
          "type": "object",
          "properties": {}
        };
        const properties = [ "name", "category_path", "assigned_terms" ];
        igcrest.getAssetPropertiesById(rid, "term", properties, maxRelatedTerms, true).then(function(res) {
          defineSchemaForTerm(res);
          // There will always be at least one relationship
          // (the object that traversed us to this one in the first place)
          if (res.assigned_terms.items.length > 1) {

          }
          schema.properties[name].properties???
          outputSchema(schema);
        }, function(err) {
          console.log(Error(err));
        });
      }
    } else {
      outputSchema(schema);
    } */

    outputSchema(schema);

  }

}

function linkTermsViaRelation(relation) {

  const path = getDefnPathFromCategoryPath(relation.category_path);
  const rid  = relation._id;
  const name = formatNameForJSON(relation._name);

  const schemaId = argv.namespace + path + "/" + name;

  let schRelation = {};

  // If it has already been processed, the relationship itself has some of 
  // its own attributes ("has a" relationships), which we should include as 
  // part of configuring the relationship within the other object(s)
  if (hmProcessedRIDs.hasOwnProperty(rid)) {
    schRelation = readSchema(schemaId);
  }
  // Otherwise, the relationship has no attributes of its own, and should
  // presumably just setup a relationship between the objects

  const hmRelatedRidsToObjectIds = {};
  for (let i = 0; i < relation.assigned_terms.items.length; i++) {
    const rtRid  = relation.assigned_terms.items[i]._id;
    const rtName = formatNameForJSON(relation.assigned_terms.items[i]._name);
    if (!hmProcessedRIDs.hasOwnProperty(rtRid)) {
      console.log(" ... WARNING: unable to find a previously processed schema for " + rtName + " (" + rtRid + ") while processing relation " + schemaId + " (" + rid + ")");
      //getTermDetails(rtRid);
    } else {
      hmRelatedRidsToObjectIds[rtRid] = hmRidToObject[rtRid].jsonSchemaId;
    }
  }

  const aRids = Object.keys(hmRelatedRidsToObjectIds);
  for (let j = 0; j < aRids.length; j++) {
    const rtRid     = aRids[j];
    const rtObjId   = hmRelatedRidsToObjectIds[rtRid];
    const schUpdate = readSchema(rtObjId);
    let bContinue   = true;
    if (!schUpdate.hasOwnProperty("properties")) {
      console.log(" ... WARNING: schema was not an object " + rtObjId + " while processing relation " + schemaId + " (" + rid + ") -- forcing its addition");
      schUpdate.type = "object"
      schUpdate.properties = {};
      schUpdate.properties[name] = {
        "type": "object",
        "properties": {}
      };
      if (schRelation.hasOwnProperty("properties")) {
        schUpdate.properties[name].properties = schRelation.properties;
      }
    } else if (!schUpdate.properties.hasOwnProperty(name)) {
      schUpdate.properties[name] = {
        "type": "object",
        "properties": {}
      };
      if (schRelation.hasOwnProperty("properties")) {
        schUpdate.properties[name].properties = schRelation.properties;
      }
    } else {
      console.log(" ... WARNING: schema (" + rtObjId + ") already has a property for relationship " + name + " while processing relation " + schemaId + " (" + rid + ") -- skipping");
      console.log("     " + JSON.stringify(schUpdate.properties[name]));
      bContinue = false;
    }
    for (let k = 0; k < aRids.length && bContinue; k++) {
      const otherRid = aRids[k];
      if (rtRid !== otherRid) {
        const otherObjId   = hmRelatedRidsToObjectIds[otherRid];
        const otherObjName = otherObjId.split(/[\\/]/).pop();
        schUpdate.properties[name].properties[otherObjName] = { "$ref": otherObjId };
      }
    }
    outputSchema(schUpdate);
  }

}

function getDefnPathFromCategoryPath(pathObj) {
  let defn = "";
  for (let i = pathObj.items.length - 1; i >= 0; i--) {
    defn = defn + "/" + formatNameForJSON(pathObj.items[i]._name);
  }
  return defn;
}

// Prefer the long_description (if it's populated),
// if not take the short_description
// or default to an empty description if both are empty
function getSingularDescription(term) {
  let desc = "";
  if (term.long_description !== "") {
    desc = term.long_description;
  } else if (term.short_description !== "") {
    desc = term.short_description;
  }
  return desc;
}

function setJSONSchemaTypeFromIGCType(schema, type) {
  if (type === "date") {
    schema.type   = "string";
    schema.format = "date";
  } else if (type === "timestamp") {
    schema.type = "string";
    schema.format = "date-time";
  } else {
    schema.type = type;
  }
}

function getSchemaFileFromId(schemaId) {
  return argv.directory + path.sep + schemaId.split(/[\\/]/).pop() + ".json";
}

function outputSchema(schema) {
  const outputFile = getSchemaFileFromId(schema.id);
  const options = {
    "encoding": 'utf8',
    "mode": 0o644,
    "flag": 'w'
  };
  fs.writeFileSync(outputFile, pd.json(schema), options);
}

function readSchema(schemaId) {
  const inputFile = getSchemaFileFromId(schemaId);
  const options = {
    "encoding": 'utf8'
  };
  return JSON.parse(fs.readFileSync(inputFile, options));
}

function formatNameForJSON(name) {
  return uppercamelcase(name.replace(/[/]/g, "-"));
}
