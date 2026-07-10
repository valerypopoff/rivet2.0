import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import { createMarkdownHtmlSanitizer } from './sanitizeMarkdownHtml.js';

const sanitize = createMarkdownHtmlSanitizer(new JSDOM('').window as never);

test('keeps ordinary Markdown structures', () => {
  const html = sanitize(String(marked('# Heading\n\n- **one**\n- two\n\n```js\nconst value = 1;\n```')));

  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<li><strong>one<\/strong><\/li>/);
  assert.match(html, /<code class="language-js">/);
});

test('removes active HTML, event attributes, and unsafe URLs', () => {
  const html = sanitize(`
    <script>alert(1)</script>
    <img src=x onerror="alert(2)">
    <a href="javascript:alert(3)" onclick="alert(4)">unsafe</a>
    <a href="https://example.com/path">safe</a>
    <svg><a href="javascript:alert(5)">svg</a></svg>
  `);

  assert.doesNotMatch(html, /script|onerror|onclick|javascript:|<img|<svg/i);
  assert.match(html, /<a>unsafe<\/a>/);
  assert.match(html, /href="https:\/\/example\.com\/path"/);
});

test('allows relative, hash, and mail links while rejecting unknown protocols', () => {
  const html = sanitize(`
    <a href="docs/page">relative</a>
    <a href="#section">hash</a>
    <a href="mailto:user@example.com">mail</a>
    <a href="ftp://example.com/file">ftp</a>
    <a href="//example.com/file">protocol relative</a>
  `);

  assert.match(html, /href="docs\/page"/);
  assert.match(html, /href="#section"/);
  assert.match(html, /href="mailto:user@example\.com"/);
  assert.doesNotMatch(html, /ftp:|href="\/\//);
});
