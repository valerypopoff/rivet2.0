import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeInputDefinition, PortId } from '@valerypopoff/rivet2-core';
import {
  applyOrderedDefinitionSubset,
  areStringArraysEqual,
  getOrderedPortDefinitions,
  getPortOrderFromElementSnapshots,
} from './portReorderInteraction.js';

function port(id: string): NodeInputDefinition {
  return {
    dataType: 'string',
    id: id as PortId,
    title: id,
  };
}

test('getOrderedPortDefinitions ignores stale ids and appends missing ports in default order', () => {
  assert.deepEqual(
    getOrderedPortDefinitions([port('a'), port('b'), port('c')], ['c', 'stale', 'a']).map((definition) => definition.id),
    ['c', 'a', 'b'],
  );
});

test('applyOrderedDefinitionSubset keeps non-reorderable definitions around the moved subset', () => {
  assert.deepEqual(
    applyOrderedDefinitionSubset([port('fixed-a'), port('x'), port('y'), port('fixed-b')], [port('y'), port('x')]).map(
      (definition) => definition.id,
    ),
    ['fixed-a', 'y', 'x', 'fixed-b'],
  );
});

test('getPortOrderFromElementSnapshots moves the source port between pointer rows', () => {
  assert.deepEqual(
    getPortOrderFromElementSnapshots({
      clientY: 35,
      portElements: [
        { portId: 'a', top: 0, height: 20 },
        { portId: 'b', top: 20, height: 20 },
        { portId: 'c', top: 40, height: 20 },
      ],
      portIds: ['a', 'b', 'c'],
      portOrder: ['a', 'b', 'c'],
      sourcePortId: 'a' as PortId,
    }),
    ['b', 'a', 'c'],
  );
});

test('getPortOrderFromElementSnapshots returns undefined for missing rows, missing source, or no-op moves', () => {
  assert.equal(
    getPortOrderFromElementSnapshots({
      clientY: 35,
      portElements: [],
      portIds: ['a', 'b', 'c'],
      portOrder: ['a', 'b', 'c'],
      sourcePortId: 'a' as PortId,
    }),
    undefined,
  );

  assert.equal(
    getPortOrderFromElementSnapshots({
      clientY: 35,
      portElements: [
        { portId: 'a', top: 0, height: 20 },
        { portId: 'b', top: 20, height: 20 },
      ],
      portIds: ['a', 'b'],
      portOrder: ['a', 'b'],
      sourcePortId: 'missing' as PortId,
    }),
    undefined,
  );

  assert.equal(
    getPortOrderFromElementSnapshots({
      clientY: 5,
      portElements: [
        { portId: 'a', top: 0, height: 20 },
        { portId: 'b', top: 20, height: 20 },
      ],
      portIds: ['a', 'b'],
      portOrder: ['a', 'b'],
      sourcePortId: 'a' as PortId,
    }),
    undefined,
  );
});

test('applyOrderedDefinitionSubset returns the original definition order when the subset is empty', () => {
  assert.deepEqual(
    applyOrderedDefinitionSubset([port('fixed-a'), port('fixed-b')], []).map((definition) => definition.id),
    ['fixed-a', 'fixed-b'],
  );
});

test('applyOrderedDefinitionSubset ignores stale subset definitions', () => {
  assert.deepEqual(
    applyOrderedDefinitionSubset(
      [port('fixed-a'), port('x'), port('y'), port('fixed-b')],
      [port('stale'), port('y'), port('x')],
    ).map((definition) => definition.id),
    ['fixed-a', 'y', 'x', 'fixed-b'],
  );
});

test('areStringArraysEqual compares order exactly', () => {
  assert.equal(areStringArraysEqual(['a', 'b'], ['a', 'b']), true);
  assert.equal(areStringArraysEqual(['a', 'b'], ['b', 'a']), false);
});
