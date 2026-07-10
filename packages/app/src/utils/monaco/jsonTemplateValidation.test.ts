import assert from 'node:assert/strict';
import test from 'node:test';

import { createJsonTemplateValidationProjection, validateJsonTemplate } from './jsonTemplateValidation.js';

test('JSON template validation accepts interpolation tokens in value, key, string, and whole-document positions', () => {
  const validTemplates = [
    '{ "age": {{age}} }',
    '{ {{key}}: "value" }',
    '{ "name": "{{name}}", "message": "Hello {{name}}" }',
    '{{object}}',
    '[{{first}}, "{{second}}"]',
  ];

  for (const template of validTemplates) {
    assert.deepEqual(validateJsonTemplate(template), [], template);
  }
});

test('JSON template projection keeps escaped interpolation literal', () => {
  assert.notDeepEqual(validateJsonTemplate('{{{literal}}}'), []);
});

test('JSON template validation still reports ordinary JSON syntax errors', () => {
  const template = '{ "age": {{age}}, "name": }';
  const [diagnostic] = validateJsonTemplate(template);

  assert.ok(diagnostic);
  assert.match(diagnostic.message, /Invalid JSON template:/);
  assert.ok(diagnostic.start >= template.indexOf('"name"'));
  assert.ok(diagnostic.start <= template.length);
});

test('JSON template validation maps parse positions after placeholder projection back to source text', () => {
  const template = '{ "value": {{value}}, "broken": }';
  const [diagnostic] = validateJsonTemplate(template);

  assert.ok(diagnostic);
  assert.ok(diagnostic.start > template.indexOf('{{value}}'));
  assert.ok(diagnostic.start <= template.length);
});

test('JSON template validation projection records a source map for replaced interpolation', () => {
  const template = '{ {{key}}: {{value}}, "message": "Hello {{name}}" }';
  const { projectedText, sourceMap } = createJsonTemplateValidationProjection(template);
  const keyProjectionOffset = projectedText.indexOf('"rivetKey"');
  const valueProjectionOffset = projectedText.indexOf('null');
  const stringProjectionOffset = projectedText.indexOf('rivet', projectedText.indexOf('Hello'));

  assert.equal(validateJsonTemplate(template).length, 0);
  assert.equal(sourceMap[keyProjectionOffset], template.indexOf('{{key}}'));
  assert.equal(sourceMap[valueProjectionOffset], template.indexOf('{{value}}'));
  assert.equal(sourceMap[stringProjectionOffset], template.indexOf('{{name}}'));
});
