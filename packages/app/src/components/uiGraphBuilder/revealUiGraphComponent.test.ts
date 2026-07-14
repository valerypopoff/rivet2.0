import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { getUiGraphComponentRevealScrollTop, isUiGraphComponentEventTarget } from './revealUiGraphComponent.js';

test('recognizes pointer targets inside either web-app component frame', () => {
  const dom = new JSDOM(`
    <div data-ui-graph-component-id="component"><button id="inside">Inside</button></div>
    <div data-ui-graph-builder-owned-portal><button id="portal">Option</button></div>
    <button id="outside">Outside</button>
  `);

  assert.equal(isUiGraphComponentEventTarget(dom.window.document.querySelector('#inside')), true);
  assert.equal(isUiGraphComponentEventTarget(dom.window.document.querySelector('#portal')), true);
  assert.equal(isUiGraphComponentEventTarget(dom.window.document.querySelector('#outside')), false);
  assert.equal(isUiGraphComponentEventTarget(null), false);
  dom.window.close();
});

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
