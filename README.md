
## JSON Schema Support
The intention is to be able to capture in IGC the same level of richness as would typically be documented / used in an API -- hence the initial focus is around support for the Schema Object as defined by the Open API specification (https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md#schema-object).

Currently this is primarily a prototype, which implements the following objects & properties:
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

Note that the properties not preceded by a '$' must be preceded by a '$' when defining in the asset XML and / or accessing via REST API; those that are already preceded by '$' do not need an additional '$'.

Currently the following properties are not implemented:
- allOf
- additionalProperties
- externalDocs

Any extended properties defined using ^x- are also not implemented.

