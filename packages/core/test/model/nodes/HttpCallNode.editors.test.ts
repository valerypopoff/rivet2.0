import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  HttpCallNodeImpl,
  getHttpCallBodyPreviewSections,
  createNode,
  flattenEditors,
  installHttpCallNodeTestHooks,
  requestErrorOutputId,
  requestFailedOutputId,
  statusCodeOutputId,
} from './HttpCallNode.testUtils.js';

installHttpCallNodeTestHooks();

void test('creates with catchRequestFailed disabled by default', () => {
  const node = HttpCallNodeImpl.create();

  assert.equal(node.type, 'httpCall');
  assert.equal(node.data.catchRequestFailed, false);
  assert.equal(node.data.retryOnNon200, false);
  assert.equal(node.data.retryOnNon200RepeatTimes, 1);
  assert.equal(node.data.retryOnNon200CooldownMs, 0);
});
void test('includes the Catch all request failures toggle in the editor config', () => {
  const node = new HttpCallNodeImpl(HttpCallNodeImpl.create());
  const editors = node.getEditors();

  assert.ok(
    editors.some(
      (editor) =>
        editor.type === 'toggle' &&
        editor.label === 'Catch all request failures' &&
        editor.dataKey === 'catchRequestFailed',
    ),
  );
});
void test('includes retry-on-non-200 editors and hides retry details until enabled', () => {
  const node = new HttpCallNodeImpl(HttpCallNodeImpl.create());
  const editors = node.getEditors();
  const flattenedEditors = flattenEditors(editors);

  const bodyEditorIndex = editors.findIndex((editor) => editor.type === 'code' && editor.dataKey === 'body');
  const binaryOutputIndex = editors.findIndex(
    (editor) => editor.type === 'toggle' && editor.dataKey === 'isBinaryOutput',
  );
  const retryGroupIndex = editors.findIndex((editor) => editor.type === 'group' && editor.label === 'Retry on non-200');
  const retryGroup = editors[retryGroupIndex];

  assert.equal(retryGroupIndex, bodyEditorIndex + 1);
  assert.equal(binaryOutputIndex, retryGroupIndex + 1);
  assert.equal(retryGroup?.type, 'group');
  assert.equal(retryGroup?.toggleDataKey, 'retryOnNon200');

  const repeatTimesEditor = flattenedEditors.find(
    (editor) => editor.type === 'number' && editor.dataKey === 'retryOnNon200RepeatTimes',
  );
  const cooldownEditor = flattenedEditors.find(
    (editor) => editor.type === 'number' && editor.dataKey === 'retryOnNon200CooldownMs',
  );

  assert.equal(repeatTimesEditor?.label, 'Repeat times');
  assert.equal(repeatTimesEditor?.defaultValue, 1);
  assert.equal(repeatTimesEditor?.min, 1);
  assert.equal(repeatTimesEditor?.layout, 'inline');
  assert.equal(repeatTimesEditor?.helperMessage, 'Times to repeat after the initial request');

  assert.equal(cooldownEditor?.label, 'Cooldown, ms');
  assert.equal(cooldownEditor?.defaultValue, 0);
  assert.equal(cooldownEditor?.min, 0);
  assert.equal(cooldownEditor?.layout, 'inline');
  assert.equal(cooldownEditor?.helperMessage, 'Milliseconds to wait between repeats');
});
void test('explains that fail-on-non-2XX checks only the final response when retry is enabled', () => {
  const node = new HttpCallNodeImpl(HttpCallNodeImpl.create());
  const failOnNon2xxEditor = node.getEditors().find(
    (editor) => editor.type === 'toggle' && editor.dataKey === 'errorOnNon200',
  );
  const helperMessage = failOnNon2xxEditor?.helperMessage;

  assert.equal(typeof helperMessage, 'function');
  if (typeof helperMessage !== 'function') {
    throw new Error('Fail on non-2XX status code must provide a conditional helper message.');
  }

  assert.equal(helperMessage({ ...node.data, retryOnNon200: false }), undefined);
  assert.equal(
    helperMessage({ ...node.data, retryOnNon200: true }),
    'With Retry on non-200 enabled, only the final response after all retries is checked.',
  );
});
void test('exposes request failure and retry-attempt outputs only for their enabled modes', () => {
  const withoutCatch = createNode({});
  const withCatch = createNode({ catchRequestFailed: true });
  const withRetry = createNode({ retryOnNon200: true });
  const withoutCatchOutputs = withoutCatch.getOutputDefinitions();
  const withCatchOutputs = withCatch.getOutputDefinitions();
  const withRetryOutputs = withRetry.getOutputDefinitions();
  const withoutCatchOutputIds = withoutCatchOutputs.map((definition) => definition.id);
  const withCatchOutputIds = withCatchOutputs.map((definition) => definition.id);
  const withRetryOutputIds = withRetryOutputs.map((definition) => definition.id);

  assert.equal(withoutCatchOutputIds.includes(requestFailedOutputId), false);
  assert.equal(withoutCatchOutputIds.includes(requestErrorOutputId), false);
  assert.equal(withoutCatchOutputs.find((definition) => definition.id === statusCodeOutputId)?.dataType, 'number');

  assert.equal(withCatchOutputIds.includes(requestFailedOutputId), true);
  assert.equal(withCatchOutputIds.includes(requestErrorOutputId), true);
  assert.equal(withCatchOutputs.find((definition) => definition.id === statusCodeOutputId)?.dataType, 'number');
  assert.equal(withCatchOutputs.find((definition) => definition.id === requestFailedOutputId)?.dataType, 'boolean');
  assert.equal(withCatchOutputs.find((definition) => definition.id === requestErrorOutputId)?.dataType, 'string');

  assert.equal(withRetryOutputIds.includes(requestFailedOutputId), true);
  assert.equal(withRetryOutputIds.includes(requestErrorOutputId), true);
  assert.equal(withRetryOutputs.find((definition) => definition.id === statusCodeOutputId)?.dataType, 'number[]');
  assert.equal(withRetryOutputs.find((definition) => definition.id === requestFailedOutputId)?.dataType, 'boolean[]');
  assert.equal(withRetryOutputs.find((definition) => definition.id === requestErrorOutputId)?.dataType, 'string[]');
});
void test('builds HTTP body preview sections for selected options', () => {
  const node = createNode({
    method: 'POST',
    url: 'https://google.com',
    errorOnNon200: true,
    catchRequestFailed: true,
    retryOnNon200: true,
    retryOnNon200RepeatTimes: 1,
    retryOnNon200CooldownMs: 1000,
  });

  const expectedSections = [
    'POST https://google.com',
    'Throw on non-2XX',
    'Catch all request failures',
    'Retry on non-200 (1 repeats, 1000ms cooldown)',
  ];

  assert.deepStrictEqual(getHttpCallBodyPreviewSections(node.data), expectedSections);
  assert.equal(node.getBody(), expectedSections.join('\n'));
});
void test('does not expose old HTTP retry-attempt output definitions', () => {
  const node = createNode({ retryOnNon200: true });
  const outputIds = node.getOutputDefinitions().map((definition) => definition.id);

  assert.equal(outputIds.includes('statusCodes' as PortId), false);
  assert.equal(outputIds.includes('requestFailedAttempts' as PortId), false);
  assert.equal(outputIds.includes('requestErrors' as PortId), false);
});
