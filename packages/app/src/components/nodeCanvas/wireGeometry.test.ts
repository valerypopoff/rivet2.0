import assert from 'node:assert/strict';
import test from 'node:test';
import { getWirePath, getWireSegments } from './wireGeometry.js';

const start = { x: 10, y: 20 };
const end = { x: 110, y: 120 };
const bendPoint = { x: 60, y: 70 };

test('getWireSegments renders one segment for ordinary wires', () => {
  assert.deepEqual(getWireSegments({ start, end }), [{ start, end }]);
});

test('getWireSegments splits bent wires at the stored bend point', () => {
  assert.deepEqual(getWireSegments({ start, end, bendPoint }), [
    { start, end: bendPoint },
    { start: bendPoint, end },
  ]);
});

test('getWirePath uses a forward cubic path when the target is to the right', () => {
  assert.equal(getWirePath({ sx: 0, sy: 10, ex: 100, ey: 20 }), 'M0,10 C50,10 50,20 100,20');
});

test('getWirePath routes backwards wires through a horizontal midpoint bridge', () => {
  assert.equal(
    getWirePath({ sx: 100, sy: 10, ex: 0, ey: 30 }),
    'M100,10 C112,10 112,20 100,20 L0,20 C-12,20 -12,30 0,30',
  );
});
