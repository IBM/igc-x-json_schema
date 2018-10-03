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
 * @file Generates JSON Schema definitions from payloads on a Kafka topic
 * @license Apache-2.0
 * @requires ibm-iis-kafka
 * @requires fs-extra
 * @requires pretty-data
 * @requires generate-schema
 * @requires yargs
 * @param d {string} - JSON Schema directory into which to put output file(s)
 * @param p {string} - property to use to distinguish different payload types (schemas)
 * @param t {string} - topic name
 * @param c {string} - connection details (hostname:port) for zookeeper connection
 * @example
 * // generates JSON Schema files for each different 'eventType' on the InfosphereEvents topic at localhost:52181
 * ./generateJSONSchemaForKafkaTopic.js -d /schemas/for/InfosphereEvents -t InfosphereEvents -p eventType -c localhost:52181 -n https://www.ibm.com/InfoSphere/InformationServer/InfosphereEvents
 */

const path = require('path');
const iiskafka = require('ibm-iis-kafka');
const fs = require('fs-extra');
const pd = require('pretty-data').pd;
const GenerateSchema = require('generate-schema');

// Command-line setup
const yargs = require('yargs');
const argv = yargs
    .usage('Usage: $0 -d <path> -p <string> -t <string> -c <string>')
    .example('$0 -d /schema/location -t InfosphereEvents -p eventType -c localhost:52181 -n https://www.ibm.com/InfoSphere/InformationServer/InfosphereEvents', 'generates JSON Schema files for each different "eventType" on the InfosphereEvents topic at localhost:52181')
    .alias('d', 'directory').nargs('d', 1).describe('d', 'Output directory for JSON Schema file(s)')
    .alias('p', 'property').nargs('p', 1).describe('p', 'Property of a payload to use to distinguish its schema from others')
    .alias('t', 'topic').nargs('t', 1).describe('t', 'Name of the Kafka topic for which to generate JSON Schema definition(s)')
    .alias('c', 'connection').nargs('c', 1).describe('c', 'Connection for zookeeper in the form hostname:port')
    .alias('n', 'namespace').nargs('n', 1).describe('n', 'A fully-qualified URL namespace to uniquely scope the schema(s)')
    .demandOption(['d','c','t','p','n'])
    .help('h')
    .alias('h', 'help')
    .wrap(yargs.terminalWidth())
    .argv;

// Base settings
const bByProperty = (typeof argv.property !== 'undefined' && argv.property !== null && argv.property !== "");

const aEvents = [];
const hmEventByType = {};
let eventCount = 0;

console.log("======================================================================");
console.log("The process will run indefinitely trying to consume events.");
console.log("When you are happy with number of events consumed, press CTRL-C");
console.log("to generate the schemas.");
console.log("======================================================================");

const infosphereEventEmitter = new iiskafka.InfosphereEventEmitter(argv.connection, 'json-schema-generator', true, argv.topic, argv.property, 1000);
infosphereEventEmitter.on(argv.topic, function(infosphereEvent, eventCtx, commitCallback) {
  eventCount += 1;
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(`... total events consumed: ${eventCount}`);
  if (bByProperty) {
    const type = infosphereEvent[argv.property];
    if (!hmEventByType.hasOwnProperty(type)) {
      hmEventByType[type] = [];
    }
    hmEventByType[type].push(infosphereEvent);
  } else {
    if (!hmEventByType.hasOwnProperty(argv.topic)) {
      hmEventByType[argv.topic] = [];
    }
    hmEventByType[argv.topic].push(infosphereEvent);
  }
  commitCallback(eventCtx);
});
infosphereEventEmitter.on('error', function(msg) {
  console.log("Topic processing stopped due to error: " + msg);
  generateSchemas();
});
infosphereEventEmitter.on('end', function() {
  console.log("\nStopping consumption and generating schemas...");
  generateSchemas();
});

function generateSchemas() {

  if (bByProperty) {
    const aTypes = Object.keys(hmEventByType);
    for (let i = 0; i < aTypes.length; i++) {
      const type = aTypes[i];
      const payloadsOfType = hmEventByType[type];
      const schema = GenerateSchema.json(type, payloadsOfType);
      writeSchema(type + '.json', reworkSchema(schema));
    }
  } else {
    const schema = GenerateSchema.json(argv.topic, hmEventByType[argv.topic]);
    writeSchema(argv.topic + '.json', reworkSchema(schema));
  }

}

function reworkSchema(schema) {

  // 1. Remove the outer 'array' wrapping of the schema
  const newSchema = schema.items;
  newSchema['$schema'] = schema.$schema;

  // 2. Remove 'required' entries (will cause warnings when loading otherwise)
  delete newSchema.required;

  // 2. Add an 'id' entry to scope the schema definition
  newSchema['id'] = argv.namespace + "/#" + newSchema['title']

  return newSchema;

}

function writeSchema(filename, schema) {
  const outputFile = argv.directory + path.sep + filename;
  const options = {
    "encoding": 'utf8',
    "mode": 0o644,
    "flag": 'w'
  };
  fs.writeFileSync(outputFile, pd.json(schema), options);
}
