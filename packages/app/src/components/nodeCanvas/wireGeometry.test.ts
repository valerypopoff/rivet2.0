import assert from 'node:assert/strict';
import test from 'node:test';
import { getNormalOffsetWirePoints, getWirePath, getWireSegments } from './wireGeometry.js';

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

test('getWirePath can leave or enter a viewport-fixed endpoint vertically downward', () => {
  assert.equal(
    getWirePath({ sx: 0, sy: 10, ex: 100, ey: 110, startDirection: 'down' }),
    'M0,10 C0,45 50,110 100,110',
  );
  assert.equal(
    getWirePath({ sx: 0, sy: 10, ex: 100, ey: 110, endDirection: 'down' }),
    'M0,10 C50,10 100,145 100,110',
  );
});

test('normal offsets keep the two lanes evenly separated around a forward Bézier curve', () => {
  const coordinates = { sx: 0, sy: 10, ex: 100, ey: 220 };
  const forwardLane = getNormalOffsetWirePoints({ ...coordinates, offset: -2 });
  const returnLane = getNormalOffsetWirePoints({ ...coordinates, offset: 2 });

  assert.equal(forwardLane.length, returnLane.length);
  for (const [index, forwardPoint] of forwardLane.entries()) {
    const returnPoint = returnLane[index]!;
    assert.ok(
      Math.abs(Math.hypot(returnPoint.x - forwardPoint.x, returnPoint.y - forwardPoint.y) - 4) < 0.000_001,
      `Expected sample ${index} to be 4px from its paired lane`,
    );
  }
});

test('normal offsets retain exact horizontal-port endpoints on steep, close wires', () => {
  const coordinates = { sx: 280, sy: 140, ex: 360, ey: 475 };
  const upperLane = getNormalOffsetWirePoints({ ...coordinates, offset: -44 });
  const lowerLane = getNormalOffsetWirePoints({ ...coordinates, offset: 44 });

  assert.deepEqual(upperLane.at(0), { x: 280, y: 96 });
  assert.deepEqual(upperLane.at(-1), { x: 360, y: 431 });
  assert.deepEqual(lowerLane.at(0), { x: 280, y: 184 });
  assert.deepEqual(lowerLane.at(-1), { x: 360, y: 519 });
});

test('normal offsets preserve downward endpoint tangents', () => {
  const coordinates = {
    sx: 0,
    sy: 10,
    ex: 100,
    ey: 110,
    startDirection: 'down' as const,
    endDirection: 'down' as const,
  };
  const leftLane = getNormalOffsetWirePoints({ ...coordinates, offset: 2 });
  const rightLane = getNormalOffsetWirePoints({ ...coordinates, offset: -2 });

  assert.deepEqual(leftLane.at(0), { x: -2, y: 10 });
  assert.deepEqual(leftLane.at(-1), { x: 102, y: 110 });
  assert.deepEqual(rightLane.at(0), { x: 2, y: 10 });
  assert.deepEqual(rightLane.at(-1), { x: 98, y: 110 });
});

test('normal offsets also keep the lanes separated around backwards wire turns', () => {
  const coordinates = { sx: 100, sy: 10, ex: 0, ey: 220 };
  const forwardLane = getNormalOffsetWirePoints({ ...coordinates, offset: -2 });
  const returnLane = getNormalOffsetWirePoints({ ...coordinates, offset: 2 });

  assert.equal(forwardLane.length, returnLane.length);
  for (const [index, forwardPoint] of forwardLane.entries()) {
    const returnPoint = returnLane[index]!;
    assert.ok(
      Math.abs(Math.hypot(returnPoint.x - forwardPoint.x, returnPoint.y - forwardPoint.y) - 4) < 0.000_001,
      `Expected sample ${index} to be 4px from its paired lane`,
    );
  }
});
