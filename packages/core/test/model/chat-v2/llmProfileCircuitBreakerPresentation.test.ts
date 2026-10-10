import assert from 'node:assert/strict';
import test from 'node:test';
import type { RivetUIContext } from '../../../src/model/RivetUIContext.js';
import { getLLMProfileEditors } from '../../../src/model/chat-v2/llmChatV2NodeEditors.js';
import { getLLMProfileBodySections } from '../../../src/model/chat-v2/llmProfileBody.js';
import { createLLMProfileNodeData } from '../../../src/model/chat-v2/llmProfileTypes.js';
import { ClassifierProfileNodeImpl } from '../../../src/model/nodes/ClassifierProfileNode.js';

test('LLM Profile exposes suspension controls only in its dedicated group', async () => {
  const data = {
    ...createLLMProfileNodeData(),
    provider: 'custom' as const,
    model: 'fast-model',
  };
  const editors = await getLLMProfileEditors(data, {} as RivetUIContext);
  const reliability = editors.find((editor) => editor.type === 'group' && editor.label === 'LLM profile suspension');

  assert.ok(reliability?.type === 'group');
  assert.deepEqual(
    reliability.editors.map((editor) => ('dataKey' in editor ? editor.dataKey : undefined)),
    [
      undefined,
      'enableCircuitBreaker',
      'firstOutputTimeoutMs',
      'streamInactivityTimeoutMs',
      'circuitBreakerFailureThreshold',
      'circuitBreakerFailureWindowMs',
      'circuitBreakerOpenDurationMs',
    ],
  );
  assert.match(
    reliability.editors[0]?.type === 'info' ? reliability.editors[0].helperMessage ?? '' : '',
    /Not available in standalone Rivet/,
  );

  const timingEditors = reliability.editors.filter(
    (editor): editor is Extract<(typeof reliability.editors)[number], { type: 'number' }> =>
      editor.type === 'number' && editor.dataKey !== 'circuitBreakerFailureThreshold',
  );
  assert.deepEqual(
    timingEditors.map((editor) => ({ label: editor.label, storageMultiplier: editor.storageMultiplier })),
    [
      { label: 'Useful output wait time, seconds', storageMultiplier: 1_000 },
      { label: 'Stream inactivity timeout, seconds', storageMultiplier: 1_000 },
      { label: 'Failure window, seconds', storageMultiplier: 1_000 },
      { label: 'Suspension duration, seconds', storageMultiplier: 1_000 },
    ],
  );
});

test('LLM and Classifier suspension use identical concise hints for their shared controls', async () => {
  const llmEditors = await getLLMProfileEditors(createLLMProfileNodeData(), {} as RivetUIContext);
  const llmGroup = llmEditors.find((editor) => editor.label === 'LLM profile suspension');
  const classifierEditors = new ClassifierProfileNodeImpl(ClassifierProfileNodeImpl.create()).getEditors();
  const classifierGroup = classifierEditors.find((editor) => editor.label === 'Classifier profile suspension');
  assert.ok(llmGroup?.type === 'group');
  assert.ok(classifierGroup?.type === 'group');
  assert.deepEqual(
    classifierGroup.editors.map((editor) => ({ type: editor.type, label: editor.label })),
    llmGroup.editors
      .filter((editor) => editor.label !== 'Stream inactivity timeout, seconds')
      .map((editor) => ({
        type: editor.type,
        label: editor.label === 'Useful output wait time, seconds' ? 'Response timeout, seconds' : editor.label,
      })),
    'Classifier must mirror the LLM section order, with a batch deadline and no streaming field',
  );
  for (const classifierEditor of classifierGroup.editors) {
    if (classifierEditor.label === 'Response timeout, seconds') continue;
    const llmEditor = llmGroup.editors.find((editor) => editor.label === classifierEditor.label);
    assert.ok(llmEditor);
    assert.equal(classifierEditor.helperMessage, llmEditor.helperMessage);
    assert.equal(typeof classifierEditor.helperMessage, 'string');
    assert.ok((classifierEditor.helperMessage as string).length <= 110, 'Keep shared hints short');
  }
});

test('LLM Profile body omits default-off health settings and keeps its enabled summary concise', () => {
  const disabled = getLLMProfileBodySections(createLLMProfileNodeData());
  assert.equal(
    disabled.some((section) => section.id === 'reliability'),
    false,
  );

  const enabled = getLLMProfileBodySections({
    ...createLLMProfileNodeData(),
    enableCircuitBreaker: true,
    firstOutputTimeoutMs: 10,
    streamInactivityTimeoutMs: 20,
    circuitBreakerFailureThreshold: 4,
    circuitBreakerFailureWindowMs: 50,
    circuitBreakerOpenDurationMs: 60,
  });
  const reliability = enabled.find((section) => section.id === 'reliability');

  assert.deepEqual(reliability?.fields, [{ label: 'Automatic suspension', value: 'Configured' }]);
});
