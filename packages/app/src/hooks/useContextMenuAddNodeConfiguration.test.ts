import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addContextMenuGroups,
  createAddNodeMenuInfoBox,
  isAddNodeMenuTypeAllowed,
  isAddNodeMenuGroupVisible,
  isAddNodeMenuTypeVisible,
} from './useContextMenuAddNodeConfiguration.js';
import { NODE_PREFAB_INSTANCE_TYPE } from '@valerypopoff/rivet2-core';

test('Add node menu keeps explicitly retired types and the Convenience category out of new-node creation', () => {
  assert.equal(isAddNodeMenuTypeVisible('chat'), false);
  assert.equal(isAddNodeMenuTypeVisible('loopController'), false);
  assert.equal(isAddNodeMenuTypeVisible('chatLoop'), true);
  assert.equal(isAddNodeMenuTypeVisible('llmChatV2'), true);

  assert.equal(isAddNodeMenuTypeAllowed('referencedGraphAlias', false), false);
  assert.equal(isAddNodeMenuTypeAllowed(NODE_PREFAB_INSTANCE_TYPE, false), false);
  assert.equal(isAddNodeMenuTypeAllowed('comment', true), false);
  assert.equal(isAddNodeMenuTypeAllowed('graphInput', true), false);
  assert.equal(isAddNodeMenuTypeAllowed('text', true), true);

  assert.equal(isAddNodeMenuGroupVisible('Convenience'), false);
  assert.equal(isAddNodeMenuGroupVisible('Code'), true);
  assert.deepEqual(
    addContextMenuGroups.map((group) => group.label),
    [
      'Common',
      'Text',
      'Code',
      'AI',
      'Knowledge',
      'Lists',
      'Numbers',
      'Objects',
      'Data',
      'Logic',
      'Input/Output',
      'Advanced',
      'Custom',
      'MCP',
    ],
  );

  const infoBox = createAddNodeMenuInfoBox('text', {
    contextMenuTitle: 'Text',
    infoBoxBody: 'Creates text.',
    infoBoxTitle: 'Text Node',
    group: ['Text'],
  });
  assert.deepEqual(infoBox, { description: 'Creates text.', title: 'Text Node' });
  assert.equal('image' in infoBox, false);
});
