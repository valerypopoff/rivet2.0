import assert from 'node:assert/strict';
import test from 'node:test';

import { getJsonSchemaRequiredFieldDefinitionAtOffset } from './jsonSchemaRequiredDefinition.js';

function definitionAt(text: string, requiredField: string) {
  const requiredArrayOffset = text.indexOf('"required"');
  return definitionAtRequiredFieldAfter(text, requiredField, requiredArrayOffset);
}

function definitionAtRequiredFieldAfter(text: string, requiredField: string, requiredArrayOffset: number) {
  const sourceOffset = text.indexOf(JSON.stringify(requiredField), requiredArrayOffset);

  assert.notEqual(sourceOffset, -1, `Expected ${requiredField} in required array`);

  return getJsonSchemaRequiredFieldDefinitionAtOffset(text, sourceOffset + 1);
}

function targetText(text: string, definition: NonNullable<ReturnType<typeof definitionAt>>) {
  return text.slice(definition.targetKeyStart, definition.targetKeyEnd);
}

test('root schema required field jumps to sibling properties definition', () => {
  const text = `{
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": { "type": "string" }
    }
  }`;
  const definition = definitionAt(text, 'name');

  assert.ok(definition);
  assert.equal(targetText(text, definition), '"name"');
  assert.equal(definition.targetKeyStart, text.indexOf('"name"', text.indexOf('"properties"')));
});

test('nested schema required field resolves inside the nested sibling properties object', () => {
  const text = `{
    "required": ["outer"],
    "properties": {
      "outer": {
        "type": "object",
        "required": ["inner"],
        "properties": {
          "inner": { "type": "number" }
        }
      }
    }
  }`;
  const innerRequiredOffset = text.indexOf('"inner"', text.indexOf('"required"', text.indexOf('"outer"')));
  const definition = getJsonSchemaRequiredFieldDefinitionAtOffset(text, innerRequiredOffset + 1);

  assert.ok(definition);
  assert.equal(targetText(text, definition), '"inner"');
  assert.equal(definition.targetKeyStart, text.indexOf('"inner"', text.indexOf('"properties"', innerRequiredOffset)));
});

test('multiple required fields resolve independently', () => {
  const text = `{
    "required": ["name", "age"],
    "properties": {
      "age": { "type": "number" },
      "name": { "type": "string" }
    }
  }`;

  assert.equal(targetText(text, definitionAt(text, 'name')!), '"name"');
  assert.equal(targetText(text, definitionAt(text, 'age')!), '"age"');
});

test('bare JSON literals inside nested schemas do not break later parent required fields', () => {
  const text = `{
    "type": "object",
    "properties": {
      "child": {
        "type": "object",
        "properties": {
          "inner": { "type": "string" }
        },
        "required": ["inner"],
        "additionalProperties": false
      },
      "afterChild": { "type": "string" }
    },
    "required": ["child", "afterChild"],
    "additionalProperties": false
  }`;
  const parentRequiredOffset = text.lastIndexOf('"required"');

  assert.equal(targetText(text, definitionAtRequiredFieldAfter(text, 'child', parentRequiredOffset)!), '"child"');
  assert.equal(targetText(text, definitionAtRequiredFieldAfter(text, 'afterChild', parentRequiredOffset)!), '"afterChild"');
});

test('missing target property and clicks outside required strings return no definition', () => {
  const text = `{
    "required": ["missing"],
    "properties": {
      "name": { "type": "string" }
    }
  }`;

  assert.equal(definitionAt(text, 'missing'), undefined);
  assert.equal(getJsonSchemaRequiredFieldDefinitionAtOffset(text, text.indexOf('"properties"') + 1), undefined);
});

test('malformed arrays with structural tokens are skipped without hanging', () => {
  const text = `{
    "required": [}, "name"],
    "properties": {
      "name": { "type": "string" }
    }
  }`;
  const definition = definitionAt(text, 'name');

  assert.ok(definition);
  assert.equal(targetText(text, definition), '"name"');
});

test('required-like arrays under other property names are ignored', () => {
  const text = `{
    "notRequired": ["name"],
    "properties": {
      "name": { "type": "string" }
    }
  }`;

  assert.equal(getJsonSchemaRequiredFieldDefinitionAtOffset(text, text.indexOf('"name"', text.indexOf('[')) + 1), undefined);
});

test('escaped JSON strings are decoded before matching property keys', () => {
  const text = `{
    "required": ["first\\\\name"],
    "properties": {
      "first\\\\name": { "type": "string" }
    }
  }`;
  const definition = definitionAt(text, 'first\\name');

  assert.ok(definition);
  assert.equal(targetText(text, definition), '"first\\\\name"');
});

test('interpolation and unrelated invalid template text do not break required navigation', () => {
  const text = `{
    {{dynamicKey}}: "value",
    "required": ["name"],
    "properties": {
      "name": {
        "type": "string",
        "default": {{defaultName}}
      }
    }
  }
  trailing`;
  const definition = definitionAt(text, 'name');

  assert.ok(definition);
  assert.equal(targetText(text, definition), '"name"');
});
