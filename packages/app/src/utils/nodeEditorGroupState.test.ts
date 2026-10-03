import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveNodeEditorGroupOpen,
  setNodeEditorGroupOpen,
  type NodeEditorGroupOpenState,
} from './nodeEditorGroupState';

test('resolveNodeEditorGroupOpen uses the editor default until the group has stored state', () => {
  assert.equal(
    resolveNodeEditorGroupOpen({
      state: {},
      nodeType: 'chat',
      groupKey: 'group:Parameters:1',
      defaultOpen: true,
    }),
    true,
  );
});

test('setNodeEditorGroupOpen stores group state per node type and group key', () => {
  const state = setNodeEditorGroupOpen(
    {
      chat: {
        'group:Outputs:2': true,
      },
    } satisfies NodeEditorGroupOpenState,
    {
      nodeType: 'chat',
      groupKey: 'group:Parameters:1',
      isOpen: false,
    },
  );

  assert.deepEqual(state, {
    chat: {
      'group:Outputs:2': true,
      'group:Parameters:1': false,
    },
  });
  assert.equal(
    resolveNodeEditorGroupOpen({
      state,
      nodeType: 'chat',
      groupKey: 'group:Parameters:1',
      defaultOpen: true,
    }),
    false,
  );
});

test('node editor group state does not leak between node types', () => {
  const state = setNodeEditorGroupOpen({}, { nodeType: 'chat', groupKey: 'group:Parameters:1', isOpen: false });

  assert.equal(
    resolveNodeEditorGroupOpen({
      state,
      nodeType: 'llmChatV2',
      groupKey: 'group:Parameters:1',
      defaultOpen: true,
    }),
    true,
  );
});

test('Classifier Model preference is independent of its other sections and LLM Chat', () => {
  const state = setNodeEditorGroupOpen(
    { classifierEvaluate: { 'group:Outputs:1': true } },
    { nodeType: 'classifierEvaluate', groupKey: 'group:Model:0', isOpen: false },
  );
  assert.equal(
    resolveNodeEditorGroupOpen({ state, nodeType: 'classifierEvaluate', groupKey: 'group:Model:0', defaultOpen: true }),
    false,
  );
  assert.equal(
    resolveNodeEditorGroupOpen({
      state,
      nodeType: 'classifierEvaluate',
      groupKey: 'group:Outputs:1',
      defaultOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveNodeEditorGroupOpen({ state, nodeType: 'llmChatV2', groupKey: 'group:Model:0', defaultOpen: true }),
    true,
  );
});

test('resolveNodeEditorGroupOpen ignores invalid root state', () => {
  assert.equal(
    resolveNodeEditorGroupOpen({
      state: null,
      nodeType: 'chat',
      groupKey: 'group:Parameters:1',
      defaultOpen: true,
    }),
    true,
  );
});

test('resolveNodeEditorGroupOpen ignores invalid stored values', () => {
  assert.equal(
    resolveNodeEditorGroupOpen({
      state: {
        chat: {
          'group:Parameters:1': 'false',
        } as unknown as Record<string, boolean>,
      },
      nodeType: 'chat',
      groupKey: 'group:Parameters:1',
      defaultOpen: true,
    }),
    true,
  );
});

test('setNodeEditorGroupOpen removes invalid stale storage while updating a group', () => {
  const state = setNodeEditorGroupOpen(
    {
      chat: {
        'group:Parameters:1': 'false',
        'group:Outputs:2': true,
      },
      text: null,
    },
    {
      nodeType: 'chat',
      groupKey: 'group:Advanced:3',
      isOpen: false,
    },
  );

  assert.deepEqual(state, {
    chat: {
      'group:Outputs:2': true,
      'group:Advanced:3': false,
    },
  });
});
