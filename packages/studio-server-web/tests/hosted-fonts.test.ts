import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('hosted editor loads both Rivet UI fonts used by upstream styles', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8');

  assert.match(indexHtml, /fonts\.googleapis\.com\/css2/);
  assert.match(indexHtml, /family=Roboto:wght@400;500;600;700/);
  assert.match(indexHtml, /family=Roboto\+Mono:wght@400;500;600;700/);
});