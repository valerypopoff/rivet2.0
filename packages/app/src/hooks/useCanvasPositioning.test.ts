import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canvasToClientPosition,
  clientToCanvasPosition,
  getCanvasPositionForZoomAtClientPoint,
} from './useCanvasPositioning.js';

test('canvas coordinate conversion includes the reserved client offset in both directions', () => {
  const canvasPosition = { x: 25, y: -10, zoom: 1.5 };
  const clientOffset = { x: 0, y: 39 };
  const canvasPoint = { x: 120, y: 80 };
  const clientPoint = canvasToClientPosition(canvasPosition, clientOffset)(canvasPoint.x, canvasPoint.y);

  assert.deepEqual(clientToCanvasPosition(canvasPosition, clientOffset)(clientPoint.x, clientPoint.y), canvasPoint);
});

test('zoom anchoring preserves the canvas point beneath the client pointer with an offset', () => {
  const canvasPosition = { x: 30, y: 20, zoom: 1 };
  const clientOffset = { x: 0, y: 39 };
  const clientPoint = { x: 500, y: 300 };
  const pointBeforeZoom = clientToCanvasPosition(canvasPosition, clientOffset)(clientPoint.x, clientPoint.y);
  const zoomedPosition = getCanvasPositionForZoomAtClientPoint({
    canvasPosition,
    clientOffset,
    clientPoint,
    newZoom: 1.5,
  });

  assert.deepEqual(clientToCanvasPosition(zoomedPosition, clientOffset)(clientPoint.x, clientPoint.y), pointBeforeZoom);
});
