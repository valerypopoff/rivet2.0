import assert from 'node:assert/strict';
import test from 'node:test';
import { getUiGraphComponentRevealScrollTop } from './revealUiGraphComponent.js';

test('keeps a visible web-app component in place', () => {
  assert.equal(
    getUiGraphComponentRevealScrollTop({
      componentHeight: 60,
      componentTop: 180,
      scrollTop: 100,
      viewportHeight: 300,
    }),
    undefined,
  );
});

test('reveals web-app components above and below the pane viewport', () => {
  assert.equal(
    getUiGraphComponentRevealScrollTop({
      componentHeight: 60,
      componentTop: 200,
      scrollTop: 300,
      viewportHeight: 300,
    }),
    184,
  );
  assert.equal(
    getUiGraphComponentRevealScrollTop({
      componentHeight: 60,
      componentTop: 450,
      scrollTop: 100,
      viewportHeight: 300,
    }),
    226,
  );
});

test('keeps the title of an oversized web-app component visible', () => {
  assert.equal(
    getUiGraphComponentRevealScrollTop({
      componentHeight: 500,
      componentTop: 50,
      scrollTop: 0,
      viewportHeight: 300,
    }),
    undefined,
  );
  assert.equal(
    getUiGraphComponentRevealScrollTop({
      componentHeight: 500,
      componentTop: 350,
      scrollTop: 0,
      viewportHeight: 300,
    }),
    334,
  );
});
