import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeId } from '@valerypopoff/rivet2-core';
import { mergeSelectionBoxNodeIds } from './useSelectionBox.js';

const nodeId = (id: string) => id as NodeId;

test('mergeSelectionBoxNodeIds keeps existing selected groups while adding boxed nodes', () => {
  assert.deepEqual(
    mergeSelectionBoxNodeIds([nodeId('first-a'), nodeId('first-b')], [nodeId('second-a'), nodeId('second-b')]),
    [nodeId('first-a'), nodeId('first-b'), nodeId('second-a'), nodeId('second-b')],
  );
});

test('mergeSelectionBoxNodeIds preserves order and dedupes nodes already in the base selection', () => {
  assert.deepEqual(
    mergeSelectionBoxNodeIds([nodeId('first-a'), nodeId('shared')], [nodeId('shared'), nodeId('second-a')]),
    [nodeId('first-a'), nodeId('shared'), nodeId('second-a')],
  );
});
