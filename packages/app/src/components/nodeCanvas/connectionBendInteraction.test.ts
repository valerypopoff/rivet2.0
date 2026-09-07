import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeConnection } from '@valerypopoff/rivet2-core';
import {
  CONNECTION_BEND_CLICK_THRESHOLD_PX,
  CONNECTION_BEND_DRAG_THRESHOLD_PX,
  getGhostConnectionBendPoint,
  shouldCommitConnectionBendClick,
  updateConnectionBendDrag,
  type ConnectionBendPoint,
  type DraggingConnectionBend,
} from './connectionBendInteraction.js';

const connection = {
  inputNodeId: 'input-node',
  inputId: 'input',
  outputNodeId: 'output-node',
  outputId: 'output',
} as NodeConnection;

const point: ConnectionBendPoint = { x: 10, y: 20 };

function bendDrag(): DraggingConnectionBend {
  return {
    axisLock: undefined,
    connection,
    connectionKey: 'a',
    hasMoved: false,
    point,
    startClientX: 100,
    startClientY: 100,
    startPoint: point,
  };
}

test('connection bend interaction thresholds stay intentionally small', () => {
  assert.equal(CONNECTION_BEND_CLICK_THRESHOLD_PX, 5);
  assert.equal(CONNECTION_BEND_DRAG_THRESHOLD_PX, 2);
});

test('getGhostConnectionBendPoint returns a ghost point only for editable hover on an unbent connection', () => {
  assert.equal(
    getGhostConnectionBendPoint({
      allowEditing: true,
      hoveredConnection: connection,
      hoveredConnectionPoint: point,
    }),
    point,
  );

  assert.equal(
    getGhostConnectionBendPoint({
      allowEditing: true,
      hoveredConnection: { ...connection, bendPoint: point },
      hoveredConnectionPoint: point,
    }),
    undefined,
  );

  assert.equal(
    getGhostConnectionBendPoint({
      allowEditing: false,
      hoveredConnection: connection,
      hoveredConnectionPoint: point,
    }),
    undefined,
  );

  assert.equal(
    getGhostConnectionBendPoint({
      allowEditing: true,
      hoveredConnection: undefined,
      hoveredConnectionPoint: point,
    }),
    undefined,
  );
});

test('shouldCommitConnectionBendClick ignores drags beyond the click threshold', () => {
  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: { connectionKey: 'a', clientX: 0, clientY: 0 },
      connectionKey: 'a',
      clientX: 3,
      clientY: 4,
      hasBendPoint: false,
      isDraggingBend: false,
      isReadOnlyGraph: false,
    }),
    false,
  );

  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: { connectionKey: 'a', clientX: 0, clientY: 0 },
      connectionKey: 'a',
      clientX: 2,
      clientY: 2,
      hasBendPoint: false,
      isDraggingBend: false,
      isReadOnlyGraph: false,
    }),
    true,
  );
});

test('shouldCommitConnectionBendClick rejects non-editable or mismatched clicks', () => {
  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: { connectionKey: 'a', clientX: 0, clientY: 0 },
      connectionKey: 'a',
      clientX: 0,
      clientY: 0,
      hasBendPoint: false,
      isDraggingBend: false,
      isReadOnlyGraph: true,
    }),
    false,
  );

  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: { connectionKey: 'a', clientX: 0, clientY: 0 },
      connectionKey: 'b',
      clientX: 0,
      clientY: 0,
      hasBendPoint: false,
      isDraggingBend: false,
      isReadOnlyGraph: false,
    }),
    false,
  );

  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: undefined,
      connectionKey: 'a',
      clientX: 0,
      clientY: 0,
      hasBendPoint: true,
      isDraggingBend: false,
      isReadOnlyGraph: false,
    }),
    false,
  );

  assert.equal(
    shouldCommitConnectionBendClick({
      clickStart: undefined,
      connectionKey: 'a',
      clientX: 0,
      clientY: 0,
      hasBendPoint: false,
      isDraggingBend: true,
      isReadOnlyGraph: false,
    }),
    false,
  );
});

test('updateConnectionBendDrag returns no preview until the drag threshold is crossed', () => {
  const drag = bendDrag();

  assert.equal(
    updateConnectionBendDrag({
      clientX: 101,
      clientY: 100,
      drag,
      point: { x: 11, y: 20 },
      shiftKey: false,
    }),
    undefined,
  );

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 102,
      clientY: 100,
      drag,
      point: { x: 12, y: 20 },
      shiftKey: false,
    }),
    {
      ...drag,
      hasMoved: true,
      point: { x: 12, y: 20 },
    },
  );
});

test('updateConnectionBendDrag keeps updating after the drag threshold has already been crossed', () => {
  const drag = bendDrag();

  const movedDrag = {
    ...drag,
    hasMoved: true,
    point: { x: 12, y: 20 },
  };

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 101,
      clientY: 100,
      drag: movedDrag,
      point: { x: 13, y: 20 },
      shiftKey: false,
    }),
    {
      ...movedDrag,
      point: { x: 13, y: 20 },
    },
  );
});

test('updateConnectionBendDrag locks the first Shift drag axis until Shift is released', () => {
  const drag = bendDrag();

  const horizontal = updateConnectionBendDrag({
    clientX: 105,
    clientY: 103,
    drag,
    point: { x: 15, y: 23 },
    shiftKey: true,
  });

  assert.deepEqual(horizontal, {
    ...drag,
    axisLock: 'x',
    hasMoved: true,
    point: { x: 15, y: 20 },
  });

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 106,
      clientY: 112,
      drag: horizontal!,
      point: { x: 16, y: 32 },
      shiftKey: true,
    }),
    {
      ...horizontal,
      point: { x: 16, y: 20 },
    },
  );

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 108,
      clientY: 110,
      drag: horizontal!,
      point: { x: 18, y: 30 },
      shiftKey: false,
    }),
    {
      ...horizontal,
      axisLock: undefined,
      point: { x: 18, y: 30 },
    },
  );
});

test('updateConnectionBendDrag locks vertically when Shift drag begins more vertically', () => {
  const drag = bendDrag();

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 102,
      clientY: 106,
      drag,
      point: { x: 12, y: 26 },
      shiftKey: true,
    }),
    {
      ...drag,
      axisLock: 'y',
      hasMoved: true,
      point: { x: 10, y: 26 },
    },
  );
});

test('updateConnectionBendDrag waits for a canvas-space direction before choosing a Shift axis', () => {
  const drag = bendDrag();

  assert.deepEqual(
    updateConnectionBendDrag({
      clientX: 102,
      clientY: 100,
      drag,
      point,
      shiftKey: true,
    }),
    {
      ...drag,
      hasMoved: true,
    },
  );
});
