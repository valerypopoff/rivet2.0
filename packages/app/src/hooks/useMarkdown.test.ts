import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from './useMarkdown.js';

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
