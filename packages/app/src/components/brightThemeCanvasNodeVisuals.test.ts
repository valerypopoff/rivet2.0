import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('Bright theme tightens canvas node contrast through dedicated node visual tokens', () => {
  const colorsSource = readFileSync(join(componentsDir, '..', 'colors.css'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const fullscreenToolbarSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'FullscreenNodeOutputToolbar.tsx'),
    'utf8',
  );

  assert.match(colorsSource, /--node-output-action-opacity: 0\.2;/);
  assert.match(colorsSource, /--node-output-action-node-hover-opacity: 0\.35;/);
  assert.match(colorsSource, /--node-output-surface-bg: var\(--grey-darkest\);/);
  assert.match(colorsSource, /--node-output-success-border: var\(--success-light\);/);
  assert.match(colorsSource, /--node-port-label-color: var\(--grey-lighter\);/);
  assert.match(colorsSource, /--node-output-error-bg: color-mix\(in srgb, var\(--error\) 10%, var\(--grey-darker\) 90%\);/);
  assert.match(colorsSource, /--node-output-error-border: var\(--error-light\);/);
  assert.match(colorsSource, /--node-body-bg: var\(--grey-darker-darker\);/);
  assert.match(colorsSource, /--node-resting-shadow: 0 1px 3px rgba\(0, 0, 0, 0\.2\);/);
  assert.match(colorsSource, /--port-connected-label-color: var\(--primary-text\);/);
  assert.match(colorsSource, /--port-connected-label-opacity: 0\.5;/);
  assert.match(colorsSource, /--node-stack-front-opacity: 0\.35;/);
  assert.match(colorsSource, /--node-stack-back-opacity: 0\.15;/);
  assert.match(colorsSource, /--node-color-0: var\(--grey-darkish\);/);
  assert.match(colorsSource, /--node-color-0-foreground: var\(--foreground-bright\);/);
  assert.doesNotMatch(colorsSource, /--node-color-[1-9]-foreground:/);

  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-output-action-opacity: 0\.42;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-output-action-node-hover-opacity: 0\.62;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-output-error-bg: color-mix\(in srgb, var\(--error\) 30%, var\(--grey-darker\) 70%\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-output-error-border: var\(--error\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-body-bg: color-mix\(in srgb, var\(--secondary\) 3%, #e7edf5 97%\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-resting-shadow: 0 2px 4px rgba\(30, 30, 30, 0\.35\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--port-connected-label-color: #0d4ea8;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--port-connected-label-opacity: 0\.86;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-stack-front-opacity: 0\.72;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-stack-back-opacity: 0\.46;/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-color-0: color-mix\(in srgb, var\(--secondary\) 3%, #b8c2cf 97%\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-color-0-foreground: #0f1722;/);

  assert.match(nodeStylesSource, /opacity: var\(--node-output-action-opacity\);/);
  assert.match(nodeStylesSource, /opacity: var\(--node-output-action-node-hover-opacity\);/);
  assert.match(nodeStylesSource, /background-color: var\(--node-body-bg\);/);
  assert.match(nodeStylesSource, /box-shadow: var\(--node-resting-shadow\);/);
  assert.match(fullscreenToolbarSource, /\.toolbar-icon \{[\s\S]*color: var\(--foreground\);[\s\S]*opacity: var\(--node-output-action-opacity\);/);
  assert.match(fullscreenToolbarSource, /\.copy-json-button \{[\s\S]*color: var\(--foreground\);[\s\S]*opacity: var\(--node-output-action-opacity\);/);
  assert.match(nodeStylesSource, /--node-output-status-bg: var\(--node-output-error-bg\);/);
  assert.match(nodeStylesSource, /--node-output-status-border: var\(--node-output-error-border\);/);
  assert.match(nodeStylesSource, /color: var\(--port-connected-label-color\);/);
  assert.match(nodeStylesSource, /background-color: var\(--node-output-surface-bg\);/);
  assert.match(nodeStylesSource, /border-top: 2px solid var\(--node-output-success-border\);/);
  assert.match(nodeStylesSource, /color: var\(--node-port-label-color\);/);
  assert.match(nodeStylesSource, /opacity: var\(--port-connected-label-opacity\);/);
  assert.match(nodeStylesSource, /opacity: var\(--node-stack-front-opacity\);/);
  assert.match(nodeStylesSource, /opacity: var\(--node-stack-back-opacity\);/);

  const splitStackBaseBlock =
    /\.node\.isSplit::before,\s+\.node\.isSplit::after \{(?<styles>[\s\S]*?)\n  \}/.exec(nodeStylesSource);
  assert.doesNotMatch(splitStackBaseBlock?.groups?.styles ?? '', /box-shadow/);
});
