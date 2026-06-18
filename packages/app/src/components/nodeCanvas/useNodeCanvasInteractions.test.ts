import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getWheelZoomFactor, isCanvasPanSurface, shouldStartCanvasPan } from './useNodeCanvasInteractions.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const componentsDir = join(testDir, '..');
const hooksDir = join(componentsDir, '..', 'hooks');

function assertAlmostEqual(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to equal ${expected}`);
}

test('getWheelZoomFactor uses the configured wheel zoom sensitivity for normal zooming', () => {
  assert.equal(
    getWheelZoomFactor({
      wheelDelta: -120,
      zoomSensitivity: 0.25,
      shiftKey: false,
    }),
    1.025,
  );
  assert.equal(
    getWheelZoomFactor({
      wheelDelta: 120,
      zoomSensitivity: 0.25,
      shiftKey: false,
    }),
    0.975,
  );
});

test('getWheelZoomFactor applies the faster shift-wheel zoom multiplier', () => {
  assert.equal(
    getWheelZoomFactor({
      wheelDelta: -120,
      zoomSensitivity: 0.25,
      shiftKey: true,
    }),
    1.15,
  );
  assert.equal(
    getWheelZoomFactor({
      wheelDelta: 120,
      zoomSensitivity: 0.25,
      shiftKey: true,
    }),
    0.85,
  );
});

test('getWheelZoomFactor clamps extreme shift-wheel zoom speed so zoom-out stays positive', () => {
  assert.equal(
    getWheelZoomFactor({
      wheelDelta: -120,
      zoomSensitivity: 2,
      shiftKey: true,
    }),
    1.95,
  );
  assertAlmostEqual(
    getWheelZoomFactor({
      wheelDelta: 120,
      zoomSensitivity: 2,
      shiftKey: true,
    }),
    0.05,
  );
});

function elementWithClasses(...classNames: string[]): Element {
  const classNameSet = new Set(classNames);
  return {
    classList: {
      contains: (className: string) => classNameSet.has(className),
    },
    closest: () => null,
  } as unknown as Element;
}

test('isCanvasPanSurface accepts the root and transparent canvas layers', () => {
  assert.equal(isCanvasPanSurface(elementWithClasses('node-canvas')), true);
  assert.equal(isCanvasPanSurface(elementWithClasses('canvas-contents')), true);
  assert.equal(isCanvasPanSurface(elementWithClasses('nodes')), true);
  assert.equal(isCanvasPanSurface(elementWithClasses('wire-hit-area')), true);
  assert.equal(isCanvasPanSurface(elementWithClasses('node-body')), false);
});

test('isCanvasPanSurface accepts comment bodies but not comment headers', () => {
  assert.equal(
    isCanvasPanSurface({
      classList: { contains: () => false },
      closest: (selector: string) => (selector === '.node.isComment .node-body' ? {} : null),
    } as unknown as Element),
    true,
  );
  assert.equal(
    isCanvasPanSurface({
      classList: { contains: () => false },
      closest: () => null,
    } as unknown as Element),
    false,
  );
});

test('isCanvasPanSurface rejects normal node descendants even when events bubble to the canvas', () => {
  assert.equal(
    isCanvasPanSurface({
      classList: { contains: () => false },
      closest: (selector: string) => (selector === '.node' ? {} : null),
    } as unknown as Element),
    false,
  );
});

test('shouldStartCanvasPan refuses canvas panning during an active node drag gesture', () => {
  assert.equal(
    shouldStartCanvasPan({
      isNodeDragGestureActive: true,
      target: elementWithClasses('node-canvas'),
    }),
    false,
  );
  assert.equal(
    shouldStartCanvasPan({
      isNodeDragGestureActive: true,
      target: {
        classList: { contains: () => false },
        closest: (selector: string) => (selector === '.node.isComment .node-body' ? {} : null),
      } as unknown as Element,
    }),
    false,
  );
});

test('canvas panning accepts SVG wire hit paths as pan surfaces', () => {
  assert.equal(
    shouldStartCanvasPan({
      isNodeDragGestureActive: false,
      target: {
        classList: { contains: (className: string) => className === 'wire-hit-area' },
        closest: () => null,
      } as unknown as SVGPathElement,
    }),
    true,
  );
});

test('shouldStartCanvasPan accepts eligible canvas surfaces when no node drag gesture is active', () => {
  assert.equal(
    shouldStartCanvasPan({
      isNodeDragGestureActive: false,
      target: elementWithClasses('node-canvas'),
    }),
    true,
  );
});

test('canvas panning uses the same closed-hand cursor treatment as node dragging', () => {
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');
  const nodeCanvasStylesSource = readFileSync(join(testDir, 'nodeCanvasStyles.ts'), 'utf8');

  assert.match(nodeCanvasSource, /className=\{clsx\('node-canvas', \{/);
  assert.match(nodeCanvasSource, /'dragging-node': isDraggingNode/);
  assert.match(nodeCanvasSource, /'dragging-canvas': isDraggingCanvas/);
  assert.match(nodeCanvasStylesSource, /&\.dragging-node,[\s\S]*&\.dragging-canvas,[\s\S]*cursor: grabbing !important;/);
});

test('connection mode has explicit keyboard, context-menu, and outside-click exits', () => {
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');

  assert.match(nodeCanvasSource, /handleCanvasContextMenuRequest[\s\S]*if \(draggingWire\)[\s\S]*cancelWireDrag\(\)/);
  assert.match(
    nodeCanvasSource,
    /handleWindowKeyDown[\s\S]*event\.code !== 'Escape'[\s\S]*event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)[\s\S]*event\.stopImmediatePropagation\(\)[\s\S]*cancelWireDrag\(\)/,
  );
  assert.match(
    nodeCanvasSource,
    /window\.addEventListener\('keydown', handleWindowKeyDown, true\)[\s\S]*window\.removeEventListener\('keydown', handleWindowKeyDown, true\)/,
  );
  assert.match(nodeCanvasSource, /canvasRootRef\.current\?\.contains\(target\)[\s\S]*return;[\s\S]*cancelWireDrag\(\)/);
  assert.match(
    nodeCanvasSource,
    /document\.addEventListener\('mousedown', handleDocumentMouseDown, true\)[\s\S]*document\.removeEventListener\('mousedown', handleDocumentMouseDown, true\)/,
  );
});

test('sticky connection mode does not let a port mousedown replace the pending output wire', () => {
  const useDraggingWireSource = readFileSync(join(hooksDir, 'useDraggingWire.ts'), 'utf8');

  assert.match(
    useDraggingWireSource,
    /const isStickyConnectionModePending = useCallback\([\s\S]*latestDraggingWire\.current[\s\S]*!wireGestureStartRef\.current/,
  );
  assert.match(
    useDraggingWireSource,
    /onWireStartDrag[\s\S]*if \(isStickyConnectionModePending\(\)\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*return;[\s\S]*if \(isInput\)/,
  );
});

test('wire drag ignores non-primary port mousedowns before mutating drag state', () => {
  const useDraggingWireSource = readFileSync(join(hooksDir, 'useDraggingWire.ts'), 'utf8');

  assert.match(
    useDraggingWireSource,
    /onWireStartDrag[\s\S]*if \(event\.button !== 0\) \{[\s\S]*return;[\s\S]*event\.stopPropagation\(\);/,
  );
});

test('wire drag ignores non-primary mouseups before finalizing connections', () => {
  const useDraggingWireSource = readFileSync(join(hooksDir, 'useDraggingWire.ts'), 'utf8');

  assert.match(
    useDraggingWireSource,
    /onWireEndDrag[\s\S]*if \(event\.button !== 0\) \{[\s\S]*return;[\s\S]*if \(!latestDraggingWire\.current\)/,
  );
  assert.match(
    useDraggingWireSource,
    /const handleWindowMouseUp = \(event: MouseEvent\) => \{[\s\S]*if \(event\.button !== 0\) \{[\s\S]*return;[\s\S]*if \(!latestDraggingWire\.current/,
  );
});
