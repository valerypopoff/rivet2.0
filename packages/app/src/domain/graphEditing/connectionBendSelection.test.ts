import assert from 'node:assert/strict';
import test from 'node:test';
import { getProjectConnectionComparisonKey, type NodeConnection } from '@valerypopoff/rivet2-core';
import { getBoxedConnectionBends, moveConnectionBends, offsetConnectionBends } from './connectionBendSelection.js';

const connection = (id: string, bendPoint?: { x: number; y: number }): NodeConnection =>
  ({
    outputNodeId: id,
    outputId: 'output',
    inputNodeId: 'target',
    inputId: 'input',
    bendPoint,
  }) as NodeConnection;

test('marquee includes authored bend centers in either direction, not unbent wires', () => {
  const bends = [
    connection('a', { x: 10, y: 20 }),
    connection('b', { x: 40, y: 50 }),
    connection('c'),
    connection('d', { x: 80, y: 90 }),
  ];
  const keys = bends.slice(0, 2).map(getProjectConnectionComparisonKey);
  assert.deepEqual(getBoxedConnectionBends(bends, { x: 10, y: 20 }, { x: 50, y: 60 }), keys);
  assert.deepEqual(getBoxedConnectionBends(bends, { x: 50, y: 60 }, { x: 10, y: 20 }), keys);
});

test('group offsets preserve connection identity and can restore original positions in one operation', () => {
  const bends = [
    connection('a', { x: 10, y: 20 }),
    connection('b', { x: 40, y: 50 }),
    connection('untouched', { x: 80, y: 90 }),
  ];
  const starts = bends
    .slice(0, 2)
    .map((bend) => ({ connectionKey: getProjectConnectionComparisonKey(bend), position: { ...bend.bendPoint! } }));
  const moved = moveConnectionBends(bends, offsetConnectionBends(starts, { x: -15, y: 25 }));
  assert.deepEqual(
    moved.map((bend) => bend.bendPoint),
    [
      { x: -5, y: 45 },
      { x: 25, y: 75 },
      { x: 80, y: 90 },
    ],
  );
  assert.deepEqual(moved.map(getProjectConnectionComparisonKey), bends.map(getProjectConnectionComparisonKey));
  assert.equal(moved[2], bends[2]);
  assert.deepEqual(bends[0]!.bendPoint, { x: 10, y: 20 });
  assert.deepEqual(moveConnectionBends(moved, starts), bends);
});

test('stale moves never recreate deleted bends or connections', () => {
  const bend = connection('a', { x: 10, y: 20 });
  const moves = [{ connectionKey: getProjectConnectionComparisonKey(bend), position: { x: 100, y: 200 } }];
  assert.deepEqual(moveConnectionBends([], moves), []);
  const unbent = connection('a');
  assert.equal(moveConnectionBends([unbent], moves)[0], unbent);
});
