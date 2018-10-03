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

const igcext = require('ibm-igc-extensions');
const fs = require('fs');
const pd = require('pretty-data').pd;

/**
 * JSONSchemaOpenIGC class -- for handling JSON Schema OpenIGC representation
 */
class JSONSchemaOpenIGC {

  /**
   * Initialises a JSON Schema object for OpenIGC
   *
   * @function
   */
  constructor() {
    this._ah = new igcext.AssetHandler();
    this._id_gen = 0;
    this._objectIdentitiesToIds = {};
  }

  /**
   * Get the OpenIGC asset type from the JSON Schema object type
   * @param {string} schemaType - the JSON Schema object type (eg. string, object, array, etc)
   * @return {string}
   */
  static getIGCTypeForSchemaType(schemaType) {
    const _igcToSchemaTypes = {
      "object": "JSObject",
      "array": "JSArray",
      "string": "JSPrimitive",
      "integer": "JSPrimitive",
      "number": "JSPrimitive",
      "boolean": "JSPrimitive",
      "null": "JSPrimitive"
    };
    return _igcToSchemaTypes.hasOwnProperty(schemaType) ? _igcToSchemaTypes[schemaType] : null;
  }

  /**
   * Get the list of known attributes for a given OpenIGC asset type
   * @param {string} igcType - the OpenIGC asset type
   * @return {string}
   */
  static getKnownIGCAttributes(igcType) {
    const _commonObjAttributes = [
      'name',
      'short_description',
      '$id',
      '$format',
      '$default',
      '$enum',
      '$readOnly',
      '$example',
      '$ref',
      '$xml_name',
      '$xml_namespace',
      '$xml_prefix',
      '$xml_attribute',
      '$xml_wrapped'
    ];
    const _igcTypeToKnownAttrs = {
      "JSObject": _commonObjAttributes.concat(['$discriminator', '$maxProperties', '$minProperties', '$required']),
      "JSArray": _commonObjAttributes.concat(['$maxItems', '$minItems', '$uniqueItems']),
      "JSPrimitive": _commonObjAttributes.concat(['$type', '$multipleOf', '$maximum', '$exclusiveMaximum', '$minimum', '$exclusiveMinimum', '$maxLength', '$minLength', '$pattern'])
    };
    return _igcTypeToKnownAttrs.hasOwnProperty(igcType) ? _igcTypeToKnownAttrs[igcType] : null;
  }

  /**
   * Read in and process a JSON Schema from the provided filename
   * @param {string} filename - the name of the file from which to read the JSON Schema definition
   * @return {string[]} an array of any warnings (as strings) discovered during processing
   */
  readSchemaFromFile(filename) {

    const aWarnings = [];

    const schema = fs.readFileSync(filename, 'utf8');

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
          aWarnings.push(" ... found unexpected schema-level key: " + key);
        }
      }
    }
  
    const aHierarchyIds = this._createContainmentHierarchyObjects(assetObj.$id);
  
    const schemaId = this._mapObjectToNextId(assetObj.$id);
    if (aHierarchyIds.length > 0) {
      this._ah.addAsset('$JSON_Schema-JSchema', assetObj.name, schemaId, assetObj, '$JSPath', aHierarchyIds[aHierarchyIds.length - 1]);
    } else {
      this._ah.addAsset('$JSON_Schema-JSchema', assetObj.name, schemaId, assetObj);
    }
  
    if (jsSchema.hasOwnProperty('properties')) {
      this._translateProperties(jsSchema.properties, '#/properties', 'JSchema', schemaId);
    }
  
    // Provide the hierarchy IDs as partial IDs, so they do not replace any other objects
    // already placed within those hierarchies (if they already exist)
    this._ah.addImportAction([schemaId], aHierarchyIds);

    return aWarnings;

  }

  /**
   * Get the OpenIGC asset XML representation of the JSON Schema
   * @return {string}
   */
  getOpenIGCXML() {
    return this._ah.getCustomisedXML();
  }

  /**
   * @private
   */
  _mapObjectToNextId(identity) {
    this._id_gen++;
    const internalId = "xt" + this._id_gen;
    this._objectIdentitiesToIds[identity] = internalId;
    return internalId;
  }

  /**
   * @private
   */
  _createContainmentHierarchyObjects(schemaId) {

    const aIds = [];
  
    let idToProcess = schemaId;
    // If the id includes a URL, strip off the 'http(s)://' portion
    if (idToProcess.indexOf('//') !== -1) {
      idToProcess = idToProcess.substring(idToProcess.indexOf('//') + 2);
    }
    const aTokens = idToProcess.split('/');
    let parentId = "";
    for (let i = 0; i < aTokens.length - 1; i++) {
      const token = aTokens[i];
      const hierarchyId = this._mapObjectToNextId(token);
      aIds.push(hierarchyId);
      if (i === 0) {
        this._ah.addAsset('$JSON_Schema-JSNamespace', token, hierarchyId, {});
      } else if (i === 1) {
        this._ah.addAsset('$JSON_Schema-JSPath', token, hierarchyId, {}, '$JSNamespace', parentId);
      } else {
        this._ah.addAsset('$JSON_Schema-JSPath', token, hierarchyId, {}, '$JSPath', parentId);
      }
      parentId = hierarchyId;
    }
    return aIds;
  
  }

  /**
   * @private
   */
  _translateProperties(properties, parentPath, parentType, parentId) {

    const aTitles = Object.keys(properties);
    for (let i = 0; i < aTitles.length; i++) {
      const title = aTitles[i];
      if (properties.hasOwnProperty(title)) {
        this._translatePropertyKeys(title, parentPath, properties[title], parentType, parentId);
      }
    }
  
  }

  /**
   * @private
   */
  _translatePropertyKeys(title, parentPath, propertyObj, parentType, parentId) {

    // Cannot expect titles to be globally unique -- only unique within the context of the full property hierarchy (path)
    const path = parentPath + "/" + title;
    const propertyId = this._mapObjectToNextId(path);
    let propertyTypeIGC = "";
    if (propertyObj.hasOwnProperty('type')) {
      propertyTypeIGC = JSONSchemaOpenIGC.getIGCTypeForSchemaType(propertyObj.type);
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
            this._addXMLDetailsToAsset(propertyObj[key], assetObj);
          } else if (JSONSchemaOpenIGC.getKnownIGCAttributes(propertyTypeIGC).indexOf('$' + key) !== -1) {
            assetObj['$' + key] = propertyObj[key];
          } else if (key === '$ref') {
            assetObj[key] = propertyObj[key];
          } else if (key !== 'type') {
            console.log(" ... found unhandled property (of '" + path + "'): " + key);
          }
        }
      }
    }
  
    this._ah.addAsset('$JSON_Schema-' + propertyTypeIGC, title, propertyId, assetObj, '$' + parentType, parentId);
  
    if (propertyObj.hasOwnProperty('properties')) {
      this._translateProperties(propertyObj.properties, path + "/properties", propertyTypeIGC, propertyId);
    }
    if (propertyObj.hasOwnProperty('items')) {
      this._translateArrayItems(propertyObj.items, path, propertyTypeIGC, propertyId);
    }
  
  }

  /**
   * @private
   */
  _translateArrayItems(items, parentPath, parentType, parentId) {

    const path = parentPath + "/items";
    const itemId = this._mapObjectToNextId(path);
    const assetObj = {};
  
    let arrayItemTypeIGC = "JSPrimitive";
    let bObject = false;
  
    const aKeys = Object.keys(items);
    for (let i = 0; i < aKeys.length; i++) {
      const key = aKeys[i];
      if (items.hasOwnProperty(key)) {
        if (key === 'type') {
          arrayItemTypeIGC = JSONSchemaOpenIGC.getIGCTypeForSchemaType(items.type);
          bObject = (arrayItemTypeIGC === 'JSObject');
        } else if (key === '$ref') {
          assetObj.$ref = items.$ref;
          arrayItemTypeIGC = "JSObject";
        } else if (key !== 'type' && key !== 'properties') {
          console.log(" ... found unhandled array item type: " + key);
        }
      }
    }
  
    this._ah.addAsset("$JSON_Schema-" + arrayItemTypeIGC, "items", itemId, assetObj, '$' + parentType, parentId);
    if (bObject && items.hasOwnProperty("properties")) {
      this._translateProperties(items.properties, path + "/properties", arrayItemTypeIGC, itemId);
    }
  
  }

  /**
   * @private
   */
  _addXMLDetailsToAsset(xmlDetails, assetObj) {
    const xmlKeys = Object.keys(xmlDetails);
    for (let i = 0; i < xmlKeys.length; i++) {
      const key = xmlKeys[i];
      assetObj['$xml_' + key] = xmlDetails[key];
    }
  }

}

module.exports = JSONSchemaOpenIGC;
