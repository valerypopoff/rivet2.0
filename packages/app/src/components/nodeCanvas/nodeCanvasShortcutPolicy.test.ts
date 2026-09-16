import assert from 'node:assert/strict';
import test from 'node:test';
import { getNodeCanvasShortcutPolicy } from './nodeCanvasShortcutPolicy.js';

test('normal graph canvases enable canvas, graph, and clipboard commands', () => {
  assert.deepEqual(getNodeCanvasShortcutPolicy({ comparisonInspectorOpen: false, graphCommandsDisabled: false }), {
    canvasCommandsEnabled: true,
    clipboardCommandsEnabled: true,
    graphCommandsEnabled: true,
  });
});

test('non-graph canvases retain navigation while disabling graph and clipboard commands', () => {
  assert.deepEqual(getNodeCanvasShortcutPolicy({ comparisonInspectorOpen: false, graphCommandsDisabled: true }), {
    canvasCommandsEnabled: true,
    clipboardCommandsEnabled: false,
    graphCommandsEnabled: false,
  });
});

test('comparison inspection suspends every canvas command owner', () => {
  assert.deepEqual(getNodeCanvasShortcutPolicy({ comparisonInspectorOpen: true, graphCommandsDisabled: false }), {
    canvasCommandsEnabled: false,
    clipboardCommandsEnabled: false,
    graphCommandsEnabled: true,
  });
});

test('comparison inspection remains authoritative on a non-graph canvas', () => {
  assert.deepEqual(getNodeCanvasShortcutPolicy({ comparisonInspectorOpen: true, graphCommandsDisabled: true }), {
    canvasCommandsEnabled: false,
    clipboardCommandsEnabled: false,
    graphCommandsEnabled: false,
  });
});
