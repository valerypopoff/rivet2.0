import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderMarkdown } from './useMarkdown.js';

Object.defineProperty(globalThis, 'window', { configurable: true, value: new JSDOM('').window });

test('renderMarkdown keeps links enabled by default', () => {
  const html = renderMarkdown('[Docs](https://example.com)');

  assert.match(html, /<a href="https:\/\/example\.com">Docs<\/a>/);
});

test('renderMarkdown can flatten links to plain text', () => {
  const html = renderMarkdown('Base URL: https://api\\.cerebras\\.ai/v1\n[Docs](https://example.com)', true, {
    disableLinks: true,
  });

  assert.doesNotMatch(html, /<a\b/i);
  assert.match(html, /Base URL: https:\/\/api\.cerebras\.ai\/v1/);
  assert.match(html, /Docs/);
});

test('renderMarkdown preserves safe node-body classes and literal field values', () => {
  const html = renderMarkdown(
    '<div class="rivet-node-body-field-row" style="opacity: 1">' +
      '<span class="rivet-node-body-field-label">Type:</span> ' +
      '<span class="rivet-node-body-field-value">Choice {{subject}} ...</span></div>\n' +
      '<div class="rivet-node-body-separator"></div>',
    true,
    { disableLinks: true },
  );

  assert.match(html, /class="rivet-node-body-field-label"/);
  assert.match(html, /class="rivet-node-body-field-value"/);
  assert.match(html, /Choice \{\{subject\}\} \.\.\./);
  assert.match(html, /class="rivet-node-body-separator"/);
  assert.match(html, /^<div class="rivet-node-body-field-row">/);
  assert.doesNotMatch(html, /\sstyle=/);
});
