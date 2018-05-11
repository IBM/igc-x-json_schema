
# README

Objective of this package is to provide an OpenIGC bundle for storing JSON Schema definitions, and utilities for creating new instances of these objects from JSON Schema files.  Note that this currently only covers JSON Schema itself, not any arbitrary JSON document.

The package currently contains:

- An OpenIGC bundle: to capture JSON Schema documents as a new set of asset types in IGC
- A loading utility: to create instances of JSON Schema assets in IGC from JSON Schema documents
- A generation utility: to generate JSON Schema files from IGC content (ie. the term type hierarchy)

## OpenIGC bundle

The OpenIGC bundle is defined under the `JSON_Schema` directory.  This form is loadable using the utilities provided by the https://npmjs.com/package/ibm-igc-extensions module, or the https://galaxy.ansible.com/cmgrote/ibm-infosvr-openigc Ansible role.

## Utilities

The utilities are all written in NodeJS, and can therefore be "installed" by ensuring their pre-requisites are installed.  The simplest way to do this is to run `npm install` from the root level of this repository.

(You'll of course need to have NodeJS installed first: https://nodejs.org)

They each also make use of the https://npmjs.com/package/ibm-iis-commons module to provide some basic common connectivity functionality, like the authorisation files.  Refer to the `createInfoSvrAuthFile.js` utility there for more details.

### loadJSONSchemaDefinitionsAndSidecars.js

Example automation to construct an IGC asset XML file, and load this to IGC to instantiate new JSON Schema assets, from a JSON Schema file and (optionally) a related side-car.  (See the `getJSONSchemaFromTermTypeHierarchy.js` utility below for more information on the side-cars.)

Usage:

```
node ./loadJSONSchemaDefinitionsAndSidecars.js
		-d <path>
		[-a <authfile>]
		[-p <password>]
```

Loads the JSON Schema files from the provided path as new instances of the JSON Schema OpenIGC asset type, linking them to term information provided if side-cars are also found in the provided path.

##### Examples:

```
node ./loadJSONSchemaDefinitionsAndSidecars.js
		-d /tmp/schemas
```

Loads JSON Schema files and side-cars from `/tmp/schemas`, using the default credentials in `~/.infosvrauth`, and prompting the user for the environment's password.

```
node ./loadJSONSchemaDefinitionsAndSidecars.js
		-d /tmp/schemas
		-a ~/.infosvrauth-env2
		-p mypassword
```

Loads JSON Schema files and side-cars from `/tmp/schemas`, using the credentials from `~/.infosvrauth-env2` and the password `mypassword`.

### getJSONSchemaFromTermTypeHierarchy.js

Example automation to generate JSON Schema files from the Term Type Hierarchy in IGC.  Includes generating both the JSON Schema documents themselves, as well as an IGC-specific side-car that contains information on what terms were used to generate the schemas (ie. RIDs).

Usage:

```
node ./getJSONSchemaFromTermTypeHierarchy.js
		-d <path>
		-n <namespace>
		[-l <RID>]
		[-a <authfile>]
		[-p <password>]
```

Produces both JSON Schema files (.json) as well as IGC-specific side-car files (.json.igc).  The side-car files can be used when loading the JSON Schema definitions back to IGC to link them back to the terms that were originally used to generate the JSON Schema (.json) files (see `loadJSONSchemaDefinitionsAndSidecars.js` utility above).

The actual processing of the term type hierarchy is based on a number of assumptions regarding the structure and use of relationships within the term type hierarchy:

   - `category_path` is used to specify the relative path within the `$id` of the schema
   - `has_a` relationships are used to create JSON Schema `properties`, implying the term with these relationships is of type `object`
   - `has_types` relationships are used to create a JSON Schema `enum`, with one enumerated value for each `has_types` relationship
   - `assigned_to_terms` relationships are assumed to point to a term used to represent the inter-relationship of multiple terms ("associative")
   - `assigned_assets` where the type of assigned asset is a `data_class` is used to determine the JSON Schema data `type`

##### Examples:

```
node ./getJSONSchemaFromTermTypeHierarchy.js
		-d /tmp/schemas
		-n "http://company.com"
```

Creates JSON Schema files and side-cars in `/tmp/schemas` for every term in IGC, qualifying each schema ID with `http://company.com`, using the default credentials in `~/.infosvrauth`, and prompting the user for the environment's password.

```
node ./getJSONSchemaFromTermTypeHierarchy.js
		-d /tmp/schemas
		-n "http://example.com"
		-l "6662c0f2.ee6a64fe.jfam6idqm.1usr4v9.1j88b9.s8h0083bq24klt3f0slgd"
		-a ~/.infosvrauth-env2
		-p mypassword
```

Creates JSON Schema files and side-cars in `/tmp/schemas` only for terms that reside within the category identified by RID `6662c0f2.ee6a64fe.jfam6idqm.1usr4v9.1j88b9.s8h0083bq24klt3f0slgd`, qualifying each schema ID with `http://example.com`, using the credentials from `~/.infosvrauth-env2` and the password `mypassword`.

## JSON Schema coverage

The intention is to be able to capture in IBM Information Governance Catalog (IGC) the same level of richness as would typically be documented / used in an API -- hence the initial focus is around support for the Schema Object as defined by the Open API specification (https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md#schema-object).

Currently this implements the following objects & properties:
- All native JSON Schema types (object, array, integer, number, string, boolean, and null)
- All of the following properties:
	- $schema
	- id
	- title (as 'name' in IGC)
	- description (as 'short_description' in IGC)
	- format
	- default
	- enum
	- readOnly
	- example
	- $ref (though only as a string, since not yet possible to have relationship attributes in Open IGC bundles)
	- xml (defining how to represent XML version of information, all pre-pended with 'xml_' in IGC)
		- name
		- namespace
		- prefix
		- attribute
		- wrapped
	- discriminator
	- maxProperties
	- minProperties
	- required (note that in Swagger v2 this is an array of property names, defined at the schema level; not a boolean at property level)
	- type
	- multipleOf
	- maximum
	- exclusiveMaximum
	- minimum
	- exclusiveMinimum
	- maxLength
	- minLength
	- pattern
	- maxItems
	- minItems
	- uniqueItems
	- items
	- properties

Note that the properties not preceded by a '$' must be preceded by a '$' when defining in the asset XML and / or accessing via REST API (due to IGC requiring this prefix); those that are already preceded by '$' do not need an additional '$'.

Currently the following properties are not implemented:
- allOf
- additionalProperties
- externalDocs

Any extended properties defined using ^x- are also not implemented.
