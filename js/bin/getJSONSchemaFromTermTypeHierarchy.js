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
 * @requires camelcase
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
const camelCase = require('camelcase');
const prompt = require('prompt');
prompt.colors = false;

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -d <path> -n <namespace> -m "<attributename>" [-l <RID> -s <file> -a <authfile> -p <password>]')
    .example('$0 -d /tmp/schemas -n "http://company.com/#" -m "custom_Can be Multiple"', 'creates JSON Schema files in "/tmp/schemas" and qualifying all schema ids with "http://company.com/#" (using default credentials file in ~/.infosvrauth), and determining whether something should be an array using the custom attribute "Can be Multiple"')
    .alias('d', 'directory').nargs('d', 1).describe('d', 'JSON Schema output directory')
    .alias('n', 'namespace').nargs('n', 1).describe('n', 'Unique namespaces to use for qualifying schema id')
    .alias('m', 'multipleAttr').nargs('m', 1).describe('m', 'Name of custom attribute used to indicate multiplicity')
    .alias('l', 'limit').nargs('l', 1).describe('l', 'Limit terms to those within a specific category (provide RID)')
    .alias('s', 'sidecar').nargs('s', 1).describe('s', 'JSON configuration file defining properties to include in sidecars')
    .alias('a', 'authfile').nargs('a', 1).describe('a', 'Authorisation file containing environment context')
    .alias('p', 'password').nargs('p', 1).describe('p', 'Password for invoking REST API')
    .demandOption(['d','n','m'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const envCtx = new commons.EnvironmentContext(null, argv.authfile);
let sideCarProperties = ["short_description", "long_description"];
if (typeof argv.sidecar !== 'undefined' && argv.sidecar !== null && argv.sidecar !== "") {
  sideCarProperties = JSON.parse(fs.readFileSync(argv.sidecar, {"encoding": 'utf8'}));
  if (!Array.isArray(sideCarProperties)) {
    console.error("ERROR: Provided sidecar configuration must be an array -- exiting.");
    process.exit(1);
  }
}
prompt.override = argv;

// Parameters and caches
const maxRelatedTerms = 1000;
const pathSep = "::";
const cardinalityCA = argv.multipleAttr;
const hmRidToObject = {};
const hmProcessedRIDs = {};
const hmNameClashCheck = {};
const hmTermToType = {};

// All the characteristics we need to investigate on terms
const minTermProperties = [
  "name",
  "category_path",
  "short_description",
  "long_description",
  "has_types",
  "is_a_type_of",
  "is_of",
  "has_a",
  "assigned_terms",
  "assigned_to_terms",
  cardinalityCA
];

const termProperties = Array.from(new Set(minTermProperties.concat(sideCarProperties)));

// All the terms that
// - have at least one "assigned terms" relationships to other terms
// are relationship bridges (?)
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
  igcrest.openSession().then(function() {

    const cacheAllDataClasses = new Promise(function(resolve, reject) {
      console.log("1 - cache all data classes...");
      igcrest.search({"properties":["name","data_type_filter_elements_enum","assigned_to_terms"],"types":["data_class"],"pageSize":100}).then(function(dc) {
        igcrest.getAllPages(dc.items, dc.paging).then(function(allDCs) {
          for (let i = 0; i < allDCs.length; i++) {
            // get data type from data class definition
            const types = allDCs[i].data_type_filter_elements_enum;
            for (let j = 0; j < allDCs[i].assigned_to_terms.items.length; j++) {
              // a term could be assigned multiple data classes, and actually each
              // data class could have multiple data types defined, so we need to
              // check and merge data types
              const ridTerm = allDCs[i].assigned_to_terms.items[j]._id;
              if (hmTermToType.hasOwnProperty(ridTerm)) {
                hmTermToType[ridTerm] = mergeTypes(types.push(hmTermToType[ridTerm]));
              } else {
                hmTermToType[ridTerm] = mergeTypes(types);
              }
            }
          }
          resolve();
        });
      });
    });

    const getAllTerms = new Promise(function(resolve, reject) {

      // By default, we'll grab all terms in the environment
      let qTerms = {
        "properties": termProperties,
        "types": ["term"],
        "pageSize": 100
      }
      // ... unless we've been invoked with a RID limiting the 
      // category under which to retrieve terms (then we'll limit)
      if (typeof argv.limit !== 'undefined' && argv.limit !== null && argv.limit !== "") {
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
          // Start by caching all information for all the terms we retrieved
          // (avoids repeatedly looking up again via REST)
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
            // For now assuming it's any term with "assigned_terms" relationships...
            if (allTerms[i].assigned_terms.items.length > 0) {
              aRelationTerms.push(rid);
            }
          }
          const aTerms = Object.keys(hmRidToObject);
          console.log("     total terms found = " + aTerms.length);
          console.log("     rel'n terms found = " + aRelationTerms.length);
          // Create (and output) a JSON Schema object for every non-relationship term
          console.log("  b) process all non-relationship terms");
          for (let i = 0; i < aTerms.length; i++) {
            const rid = aTerms[i];
            defineSchemaForTerm(getTermFromCache(rid));
          }
          // Don't output the relationships as JSON Schema objects themselves, instead
          // process them to embed their information in the objects that they are inter-
          // relating
          console.log("  c) add the relations");
          for (let i = 0; i < aRelationTerms.length; i++) {
            const relatedTerm = getTermFromCache(aRelationTerms[i]);
            if (relatedTerm !== null) {
              linkTermsViaRelation(relatedTerm);
            }
          }
          resolve();
  
        });
      });
    });

    cacheAllDataClasses.then(function() {
      return getAllTerms;
    }).then(function() {
      igcrest.closeSession().then(function() {
        console.log("JSON schema object creation completed.");
      }, function(failure) {
        console.log("JSON schema object creation completed, but unable to close session: " + JSON.stringify(failure));
      });
    })
    .catch(console.error);

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

// Retrieve the fully-qualified "ID" to which we can resolve
// a term (the value for a $ref key in JSON Schema)
function getTermRefFromCache(rid) {
  const term = getTermFromCache(rid);
  if (term !== null) {
    return term.jsonSchemaId;
  } else {
    return null;
  }
}

// Retrieve a term object from the cache, by RID
function getTermFromCache(rid) {
  if (hmRidToObject.hasOwnProperty(rid)) {
    return hmRidToObject[rid];
  } else {
    console.log("ERROR: Unable to find in cache -- " + rid);
    return null;
  }
}

// Actually construct a full JSON Schema object for the provided term
function defineSchemaForTerm(term) {

  const sidecar = {};  
  const schema = {
    "id": argv.namespace,
    "title": "",
    "$schema": "http://json-schema.org/draft-06/schema#"
  };

  const path = getDefnPathFromCategoryPath(term.category_path);
  const rid  = term._id;
  const name = formatNameForJSON(term._name);

  // Skip duplicate processing
  if (!hmProcessedRIDs.hasOwnProperty(rid)) {

    schema.id = schema.id + path + "/" + name;
    schema.title = name;
    schema.description = getSingularDescription(term);
    addToSidecar(sidecar, schema.id, term);

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
      // Create a property for each "has a" related term
      for (let i = 0; i < term.has_a.items.length; i++) {
        const rRid  = term.has_a.items[i]._id;
        const rName = formatNameForJSON(term.has_a.items[i]._name);
        const rObj  = getTermFromCache(rRid);
        // Check if the "has a" related term has multiple cardinality
        // (if so create an array out of it, otherwise leave it singular)
        if (rObj !== null && rObj.hasOwnProperty(cardinalityCA)
            && (rObj[cardinalityCA].toUpperCase() === "YES"
                || rObj[cardinalityCA].toUpperCase() === "TRUE"
                || rObj[cardinalityCA].toUpperCase() === "Y")
            ) {
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
      // (so include the types as valid values in an enum)
      schema.enum = [];
      for (let i = 0; i < term.has_types.items.length; i++) {
        schema.enum.push(term.has_types.items[i]._name);
      }
      // ... and also set the basic type for the enum
      if (hmTermToType.hasOwnProperty(rid)) {
        setJSONSchemaTypeFromIGCType(schema, hmTermToType[rid]);
      } else {
        // catch-all -- in case the term has not been associated with
        // a data class, it will default to "string" as lowest common denominator
        setJSONSchemaTypeFromIGCType(schema, "string");
      }
    } else {
      // otherwise, determine the simple data type
      if (hmTermToType.hasOwnProperty(rid)) {
        setJSONSchemaTypeFromIGCType(schema, hmTermToType[rid]);
      } else {
        // catch-all -- in case the term has not been associated with
        // a data class, it will default to "string" as lowest common denominator
        setJSONSchemaTypeFromIGCType(schema, "string");
      }
    }
  
    if (term.assigned_terms.items.length > 0) {
      schema['x-relation-object'] = true;
    }
/*    // If we want to try to embed relationship processing directly in this step,
    // below might be a starter...
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

    outputSidecar(sidecar);
    outputSchema(schema);

  }

}

// Determines what relationship information to embed in other schemas for the
// "associative" (purely relationship / linking) terms
function linkTermsViaRelation(relation) {

  const relnPath = getDefnPathFromCategoryPath(relation.category_path);
  const relnRid  = relation._id;
  const relnName = formatNameForJSON(relation._name);

  const relnSchId = argv.namespace + relnPath + "/" + relnName;

  let schRelation  = {};

  // If it has already been processed, the relationship itself has some of 
  // its own attributes ("has a" relationships), which we should include as 
  // part of configuring the relationship within the other object(s)
  if (hmProcessedRIDs.hasOwnProperty(relnRid)) {
    schRelation  = readSchema(relnSchId);
  }
  // Otherwise, the relationship has no attributes of its own, and should
  // presumably just setup a relationship between the objects

  // First pass we'll get a list of all of the names for the "assigned_terms"
  // in the relationship object
  const hmRelatedRidsToObjectIds = {};
  for (let i = 0; i < relation.assigned_terms.items.length; i++) {
    const rtRid  = relation.assigned_terms.items[i]._id;
    const rtName = formatNameForJSON(relation.assigned_terms.items[i]._name);
    if (!hmProcessedRIDs.hasOwnProperty(rtRid)) {
      console.log(" ... WARNING: unable to find a previously processed schema for " + rtName + " (" + rtRid + ") while processing relation " + relnSchId + " (" + relnRid + ")");
    } else {
      hmRelatedRidsToObjectIds[rtRid] = getTermRefFromCache(rtRid);
    }
  }

  // Then we'll iterate through all of the RIDs for these "assigned_terms" to:
  // - create a new relationship property on each of the terms
  // - add each as a "$ref" within that relationship property each of the other
  //   terms
  const aRids = Object.keys(hmRelatedRidsToObjectIds);
  for (let j = 0; j < aRids.length; j++) {

    const rtRid      = aRids[j];
    const rtObjId    = hmRelatedRidsToObjectIds[rtRid];
    const schUpdate  = readSchema(rtObjId);

    let bContinue   = true;
    if (!schUpdate.hasOwnProperty("properties")) {
      // If the term we need to update is not already an object, we need to force it
      // into being one (so that we can add these relationships to it)
      console.log(" ... WARNING: schema was not an object " + rtObjId + " while processing relation " + relnSchId + " (" + relnRid + ") -- forcing its addition");
      schUpdate.type = "object"
      schUpdate.properties = {};
      schUpdate.properties[relnName] = {
        "type": "object",
        "properties": {}
      };
      // Add any existing attributes of the relationship itself to the properties
      // on the term
      if (schRelation.hasOwnProperty("properties")) {
        schUpdate.properties[relnName].properties = JSON.parse(JSON.stringify(schRelation.properties));
      }
    } else if (!schUpdate.properties.hasOwnProperty(relnName)) {
      // Otherwise if the term is already an object but does not yet have any
      // property defined for this relationship, we need to add the relationship property
      schUpdate.properties[relnName] = {
        "type": "object",
        "properties": {}
      };
      // Add any existing attributes of the relationship itself to the properties
      // on the term
      if (schRelation.hasOwnProperty("properties")) {
        schUpdate.properties[relnName].properties = JSON.parse(JSON.stringify(schRelation.properties));
      }
    } else {
      // Finally, if the term already has a property defined for this relationship
      // then it isn't clear what we should do -- so we'll skip over clobbering it
      console.log(" ... WARNING: schema (" + rtObjId + ") already has a property for relationship " + relnName + " while processing relation " + relnSchId + " (" + relnRid + ") -- skipping");
      console.log("     " + JSON.stringify(schUpdate.properties[relnName]));
      bContinue = false;
    }

    // We then need to iterate again through all of the "assigned_terms"
    // and add a "$ref" for each one that is not self-referencing the term in which
    // we've placed the new relationship property
    const aInheritedTermRids = getAncestralTerms(getTermFromCache(rtRid));
    aInheritedTermRids.push(rtRid);
    for (let k = 0; k < aRids.length && bContinue; k++) {
      const otherRid = aRids[k];
      if (aInheritedTermRids.indexOf(otherRid) === -1) {
        const otherObjId   = hmRelatedRidsToObjectIds[otherRid];
        const otherObjName = otherObjId.split(/[\\/]/).pop();
        schUpdate.properties[relnName].properties[otherObjName] = { "$ref": otherObjId };
      }
    }

    outputSchema(schUpdate);

  }

}

// Walks up the inheritance chain so that we know all RIDs from which
// the provided Term inherits
function getAncestralTerms(term) {
  let aTerms = [];
  if (term !== null) {
    for (let i = 0; i < term.is_a_type_of.items.length; i++) {
      const pRid = term.is_a_type_of.items[i]._id;
      aTerms.push(pRid);
      aTerms = aTerms.concat(getAncestralTerms(getTermFromCache(pRid)));
    }
  }
  return aTerms;
}

// Walks down the inheritance chain so that we know all RIDs which
// inherit from (are derived from) the provided Term
function getOffspringTerms(term) {
  let aTerms = [];
  if (term !== null) {
    for (let i = 0; i < term.has_types.items.length; i++) {
      const cRid = term.has_types.items[i]._id;
      aTerms.push(cRid);
      aTerms = aTerms.concat(getOffspringTerms(getTermFromCache(cRid)));
    }
  }
  return aTerms;
}

function getDefnPathFromCategoryPath(pathObj) {
  let defn = "";
  for (let i = pathObj.items.length - 1; i >= 0; i--) {
    defn = defn + "/" + formatNameForJSON(pathObj.items[i]._name);
  }
  return defn;
}

function getIdentityForTerm(term) {
  let path = "";
  for (let i = term.category_path.items.length - 1; i >= 0; i--) {
    path = path + term.category_path.items[i]._name + pathSep;
  }
  return path + term._name;
}

function isLeafTerm(term) {
  return (term.has_a.items.length === 0
          && term.has_types.items.length === 0
          && term.assigned_to_terms.length === 0);
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
  } else if (type === "numeric") {
    schema.type = "number";
  } else {
    schema.type = type;
  }
}

function getSchemaFileFromId(schemaId) {
  return argv.directory + path.sep + schemaId.split(/[\\/]/).pop() + ".json";
}

function addToSidecar(sidecar, schemaId, term) {
  sidecar._schema = schemaId;
  sidecar._identity = getIdentityForTerm(term);
  sidecar._id = term._id;
  for (let i = 0; i < sideCarProperties.length; i++) {
    const prop = sideCarProperties[i];
    sidecar[prop] = term[prop];
  }
}

function outputSidecar(sidecar) {
  const outputFile = getSchemaFileFromId(sidecar._schema) + ".igc";
  const options = {
    "encoding": 'utf8',
    "mode": 0o644,
    "flag": 'w'
  };
  fs.writeFileSync(outputFile, pd.json(sidecar), options);
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
  return camelCase(name.replace(/[/\(\)]/g, "-"));
}
