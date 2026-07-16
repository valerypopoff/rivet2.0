import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_HEIGHT,
  buildCodeEditorHeightStorageKey,
  isValidHeight,
  MIN_HEIGHT,
  RESIZABLE_LANGUAGES,
  resolveStaticViewportHeight,
  resolveViewportHeight,
} from './useNodeEditorCodeViewportHeight.js';

function dragViewportHeight(startHeight: number, startClientY: number, currentClientY: number): number {
  return Math.max(MIN_HEIGHT, Math.round(startHeight + (currentClientY - startClientY)));
}

test('resolveViewportHeight prefers persisted height and falls back through default height to the shared default', () => {
  assert.equal(
    resolveViewportHeight({
      nodeType: 'httpCall',
      editorKey: 'headers',
      defaultHeight: 320,
      persistedHeights: { 'httpCall:headers': 640 },
    }),
    640,
  );
  assert.equal(
    resolveViewportHeight({ nodeType: 'code', editorKey: 'code', defaultHeight: 420, persistedHeights: {} }),
    420,
  );
  assert.equal(
    resolveViewportHeight({
      nodeType: 'object',
      editorKey: 'jsonTemplate',
      defaultHeight: undefined,
      persistedHeights: {},
    }),
    DEFAULT_HEIGHT,
  );
});

test('resolveViewportHeight ignores invalid persisted heights', () => {
  assert.equal(
    resolveViewportHeight({
      nodeType: 'tool',
      editorKey: 'schema',
      defaultHeight: 360,
      persistedHeights: { 'tool:schema': Number.NaN },
    }),
    360,
  );
});

test('resolveStaticViewportHeight returns a fixed clamped height for non-resizable editors', () => {
  assert.equal(resolveStaticViewportHeight(200), 200);
  assert.equal(resolveStaticViewportHeight(120), MIN_HEIGHT);
  assert.equal(resolveStaticViewportHeight(undefined), DEFAULT_HEIGHT);
});

test('resolveViewportHeight keeps same-language editors independent within one node type', () => {
  assert.equal(
    resolveViewportHeight({
      nodeType: 'httpCall',
      editorKey: 'headers',
      defaultHeight: 320,
      persistedHeights: {
        'httpCall:headers': 640,
        'httpCall:body': 480,
      },
    }),
    640,
  );
  assert.equal(
    resolveViewportHeight({
      nodeType: 'httpCall',
      editorKey: 'body',
      defaultHeight: 320,
      persistedHeights: {
        'httpCall:headers': 640,
        'httpCall:body': 480,
      },
    }),
    480,
  );
});

test('resolveViewportHeight falls back to the legacy node-type entry when a per-editor height has not been stored yet', () => {
  assert.equal(
    resolveViewportHeight({
      nodeType: 'httpCall',
      editorKey: 'headers',
      defaultHeight: 320,
      persistedHeights: { httpCall: 560 },
    }),
    560,
  );
});

test('dragViewportHeight clamps to the minimum height', () => {
  assert.equal(dragViewportHeight(500, 100, 180), 580);
  assert.equal(dragViewportHeight(250, 100, -100), MIN_HEIGHT);
});

test('buildCodeEditorHeightStorageKey namespaces persisted heights by editor identity', () => {
  assert.equal(buildCodeEditorHeightStorageKey({ nodeType: 'httpCall', editorKey: 'headers' }), 'httpCall:headers');
  assert.equal(buildCodeEditorHeightStorageKey({ nodeType: 'httpCall', editorKey: ' headers ' }), 'httpCall:headers');
  assert.equal(buildCodeEditorHeightStorageKey({ nodeType: 'code', editorKey: '' }), 'code');
  assert.equal(buildCodeEditorHeightStorageKey({ nodeType: undefined, editorKey: 'headers' }), undefined);
});

test('resizable node-editor languages include text-node prompt interpolation', () => {
  assert.equal(RESIZABLE_LANGUAGES.has('javascript'), true);
  assert.equal(RESIZABLE_LANGUAGES.has('json'), true);
  assert.equal(RESIZABLE_LANGUAGES.has('jsonpath'), true);
  assert.equal(RESIZABLE_LANGUAGES.has('prompt-interpolation-markdown'), true);
});
