import assert from 'node:assert/strict';
import test from 'node:test';
import type { DataValue } from '@valerypopoff/rivet2-core';
import { getStorageDecision } from './executionDataPreview.js';
import { REF_STORAGE_THRESHOLD_CHARS } from './outputStorageLimits.js';

test('getStorageDecision builds text previews for large strings', () => {
  const decision = getStorageDecision({
    type: 'string',
    value: 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1),
  });

  assert.equal(decision.storage, 'ref');
  assert.equal(decision.preview.kind, 'text');
  assert.equal(decision.sizeHint, REF_STORAGE_THRESHOLD_CHARS + 1);
});

test('getStorageDecision keeps malformed string payloads inline', () => {
  const decision = getStorageDecision({
    type: 'string',
    value: undefined,
  } as unknown as DataValue);

  assert.deepEqual(decision, {
    storage: 'inline',
  });
});

test('getStorageDecision keeps undefined visible in large any-array previews', () => {
  const decision = getStorageDecision({
    type: 'any[]',
    value: [
      undefined,
      ...Array.from({ length: 400 }, (_, index) => ({ [`key-${index}`]: `value-${index}-${'x'.repeat(64)}` })),
    ],
  });

  assert.equal(decision.storage, 'ref');
  assert.equal(decision.preview.kind, 'json');
  assert.match(decision.preview.excerpt, /"undefined"/);
  assert.doesNotMatch(decision.preview.excerpt, /^\[\n  null,/);
});

test('getStorageDecision stores media payloads by ref with summary previews', () => {
  const decision = getStorageDecision({
    type: 'binary',
    value: new Uint8Array([1, 2, 3]),
  });

  assert.equal(decision.storage, 'ref');
  assert.deepEqual(decision.preview, {
    kind: 'summary',
    label: 'Binary',
    totalBytes: 3,
  });
  assert.equal(decision.sizeHint, 3);
});

test('getStorageDecision builds a text preview for function-result messages with long string content', () => {
  const message = 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1);
  const decision = getStorageDecision({
    type: 'chat-message',
    value: {
      type: 'function',
      name: 'call_1',
      toolName: 'lookup',
      message,
    },
  });

  assert.equal(decision.storage, 'ref');
  assert.equal(decision.preview.kind, 'text');
  assert.equal(decision.preview.totalChars, message.length);
  assert.equal(decision.sizeHint, message.length);
});

test('getStorageDecision keeps short chat messages on the normal chat-message renderer', () => {
  const decision = getStorageDecision({
    type: 'chat-message',
    value: {
      type: 'function',
      name: 'call_1',
      toolName: 'lookup',
      message: 'short result',
    },
  });

  assert.equal(decision.storage, 'ref');
  assert.deepEqual(decision.preview, {
    kind: 'summary',
    label: 'Chat Message (function)',
    totalBytes: 12,
  });
});

test('getStorageDecision keeps long non-function chat messages on the role-aware renderer', () => {
  const message = 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS + 1);
  const decision = getStorageDecision({
    type: 'chat-message',
    value: {
      type: 'user',
      message,
    },
  });

  assert.equal(decision.storage, 'ref');
  assert.deepEqual(decision.preview, {
    kind: 'summary',
    label: 'Chat Message (user)',
    totalBytes: message.length,
  });
});

test('getStorageDecision builds a text preview for arrays of long function-result messages', () => {
  const firstMessage = 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS);
  const decision = getStorageDecision({
    type: 'chat-message[]',
    value: [
      { type: 'function', name: 'call_1', toolName: 'first', message: firstMessage },
      { type: 'function', name: 'call_2', toolName: 'second', message: 'second result' },
    ],
  });

  assert.equal(decision.storage, 'ref');
  assert.equal(decision.preview.kind, 'text');
  assert.equal(decision.preview.totalChars, firstMessage.length + 1 + 'second result'.length);
});

test('getStorageDecision keeps mixed chat-message arrays on the role-aware renderer', () => {
  const firstMessage = 'a'.repeat(REF_STORAGE_THRESHOLD_CHARS);
  const decision = getStorageDecision({
    type: 'chat-message[]',
    value: [
      { type: 'function', name: 'call_1', toolName: 'first', message: firstMessage },
      { type: 'assistant', message: 'assistant response', function_call: undefined, function_calls: undefined },
    ],
  });

  assert.equal(decision.storage, 'ref');
  assert.deepEqual(decision.preview, {
    kind: 'summary',
    label: 'Chat Message Array',
    totalBytes: firstMessage.length + 'assistant response'.length,
    itemCount: 2,
  });
});
