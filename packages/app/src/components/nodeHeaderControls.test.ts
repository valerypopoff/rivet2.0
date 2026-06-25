import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('node edit gear reveal does not animate icon color', () => {
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const editButtonBlock = /\.title-controls \.edit-button \{(?<styles>[\s\S]*?)\n  \}/.exec(nodeStylesSource)
    ?.groups?.styles;
  const editButtonHoverBlock = /\.edit-button:hover \{(?<styles>[\s\S]*?)\n    \}/.exec(nodeStylesSource)?.groups
    ?.styles;

  assert.ok(editButtonBlock, 'Expected node edit button styles to be present');
  assert.match(editButtonBlock, /transition: opacity 0\.15s ease-out;/);
  assert.doesNotMatch(editButtonBlock, /color 0\.2s ease-out/);

  assert.ok(editButtonHoverBlock, 'Expected node edit button hover styles to be present');
  assert.match(editButtonHoverBlock, /color: var\(--node-bg-foreground\);/);
  assert.doesNotMatch(editButtonHoverBlock, /primary-text/);
});
