import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

test('host.css owns the shared reset used by standalone and embedded app mounts', () => {
  const hostCss = readFileSync(join(srcDir, 'host.css'), 'utf8');
  const appTsx = readFileSync(join(srcDir, 'App.tsx'), 'utf8');

  const colorsImportIndex = hostCss.indexOf("@import './colors.css';");
  const resetImportIndex = hostCss.indexOf("@import '@atlaskit/css-reset';");

  assert.ok(colorsImportIndex >= 0, 'host.css should import app colors before the shared reset');
  assert.ok(resetImportIndex > colorsImportIndex, 'host.css should import the shared reset after app styles');
  assert.match(hostCss.slice(resetImportIndex), /body,[\s\S]*font-family: var\(--font-family\);/);
  assert.match(hostCss.slice(resetImportIndex), /code,[\s\S]*font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(appTsx, /@atlaskit\/css-reset/);
});

test('rendered Markdown output uses Rivet typography tokens', () => {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');

  assert.match(indexCss, /\.rivet-markdown-output\.markdown-body\s*{[\s\S]*font-family: var\(--font-family\);/);
  assert.match(
    indexCss,
    /\.rivet-markdown-output\.markdown-body code,[\s\S]*font-family: var\(--font-family-monospace\);/,
  );
});

test('app font loading and global code typography stay on Rivet font tokens', () => {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');
  const indexHtml = readFileSync(join(srcDir, '..', 'index.html'), 'utf8');

  assert.match(indexHtml, /family=Roboto:wght@300;400;500;700;900&family=Roboto\+Mono&display=swap/);
  assert.match(indexCss, /code\s*{[\s\S]*font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(indexCss, /source-code-pro|Menlo|Monaco|Consolas|'Courier New'/);
});

test('app root is locked to the iframe viewport', () => {
  const appSource = readFileSync(join(srcDir, 'components', 'RivetApp.tsx'), 'utf8');
  const hostCss = readFileSync(join(srcDir, 'host.css'), 'utf8');
  const resetImportIndex = hostCss.indexOf("@import '@atlaskit/css-reset';");
  assert.ok(resetImportIndex >= 0, 'host.css should import the Atlaskit reset before reasserting the viewport lock');

  const postResetCss = hostCss.slice(resetImportIndex);

  assert.match(postResetCss, /html,\s*body\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*overflow: hidden;/);
  assert.match(postResetCss, /#root\s*{[\s\S]*width: 100%;[\s\S]*height: 100%;/);
  assert.match(appSource, /const styles = css`[\s\S]*position: fixed;[\s\S]*inset: 0;/);
  assert.match(appSource, /const styles = css`[\s\S]*width: 100%;[\s\S]*height: 100%;/);
});

test('portal typography tokens keep popup surfaces on Rivet fonts', () => {
  const hostCss = readFileSync(join(srcDir, 'host.css'), 'utf8');
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');
  const resetImportIndex = hostCss.indexOf("@import '@atlaskit/css-reset';");
  const postResetCss = hostCss.slice(resetImportIndex);

  for (const token of [
    '--ds-font-family-body: var(--font-family);',
    '--ds-font-family-heading: var(--font-family);',
    '--ds-font-family-sans: var(--font-family);',
    '--ds-font-family-brand: var(--font-family);',
    '--ds-font-family-code: var(--font-family-monospace);',
    '--ds-font-family-monospace: var(--font-family-monospace);',
    '--ds-font-heading-xxsmall:',
    '--ds-font-label:',
    '--ds-text: var(--foreground);',
    '--ds-text-disabled: var(--foreground-disabled);',
    '--ds-surface: var(--modal-surface-bg);',
    '--ds-surface-overlay: var(--modal-surface-bg);',
    '--ds-border: var(--modal-border);',
    '--ds-shadow-overlay: 0 0 0 1px var(--modal-border), 0 2px 1px var(--shadow),',
    '--ds-background-input: var(--form-control-bg);',
    '--ds-background-input-hovered: var(--form-control-bg-hover);',
    '--ds-background-input-pressed: var(--form-control-bg-focus);',
    '--ds-border-input: var(--form-control-border);',
    '--ds-border-focused: var(--form-control-border-focus);',
    '--ds-background-selected: var(--form-control-selected-bg);',
    '--toastify-font-family: var(--font-family);',
  ]) {
    assert.ok(indexCss.includes(token), `index.css should define ${token}`);
    assert.ok(postResetCss.includes(token), `host.css should reassert ${token} after Atlaskit reset`);
  }
  assert.ok(indexCss.includes('--form-control-border-width: 1px;'));

  assert.match(postResetCss, /\.atlaskit-portal,[\s\S]*\.atlaskit-portal-container\s*{/);
  assert.match(postResetCss, /--ds-font-heading-xxsmall:[\s\S]*var\(--ds-font-family-heading, var\(--font-family\)\)/);
  assert.match(postResetCss, /--ds-font-label:[\s\S]*var\(--label-font-family,/);
});

test('native and react-select controls inherit tinted form-control surfaces', () => {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');

  assert.match(
    indexCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*background-color: var\(--form-control-bg\);/,
  );
  assert.match(
    indexCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*border: var\(--form-control-border-width\) solid var\(--form-control-border\);/,
  );
  assert.match(
    indexCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(indexCss, /select,[\s\S]*textarea:not\(\.inputarea\) \{[\s\S]*color: var\(--foreground\);/);
  assert.match(
    indexCss,
    /select,[\s\S]*textarea:not\(\.inputarea\) \{[\s\S]*color-scheme: var\(--form-control-color-scheme\);/,
  );
  assert.match(indexCss, /:hover,[\s\S]*select:hover,[\s\S]*background-color: var\(--form-control-bg-hover\);/);
  assert.match(indexCss, /:focus,[\s\S]*select:focus,[\s\S]*border-color: var\(--form-control-border-focus\);/);
  assert.match(
    indexCss,
    /\[class\*='-control'\]:has\(input\[id\^='react-select-'\]\) \{[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(
    indexCss,
    /\[data-ds--text-field--container\] \{[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(indexCss, /\[data-ds--text-field--input\] \{[\s\S]*border: 0 !important;/);
  assert.match(
    indexCss,
    /\[class\*='-control'\]:has\(input\[id\^='react-select-'\]\),[\s\S]*\[class\*='-menu'\] \{[\s\S]*--ds-background-input: var\(--form-control-bg\);/,
  );
});

test('host entry reasserts one-pixel form-control borders after Atlaskit reset', () => {
  const hostCss = readFileSync(join(srcDir, 'host.css'), 'utf8');
  const resetImportIndex = hostCss.indexOf("@import '@atlaskit/css-reset';");
  const postResetCss = hostCss.slice(resetImportIndex);

  assert.match(
    postResetCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*border: var\(--form-control-border-width\) solid var\(--form-control-border\);/,
  );
  assert.match(
    postResetCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(
    postResetCss,
    /input:not\(\.inputarea\):not\(\[type='checkbox'\]\)[\s\S]*color-scheme: var\(--form-control-color-scheme\);/,
  );
  assert.match(
    postResetCss,
    /\[class\*='-control'\]:has\(input\[id\^='react-select-'\]\) \{[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(
    postResetCss,
    /\[data-ds--text-field--container\] \{[\s\S]*border-width: var\(--form-control-border-width\) !important;/,
  );
  assert.match(postResetCss, /\[data-ds--text-field--input\] \{[\s\S]*border: 0 !important;/);
});

test('Bright theme asks native form controls to render light built-in widgets', () => {
  const colorsCss = readFileSync(join(srcDir, 'colors.css'), 'utf8');

  assert.match(colorsCss, /--form-control-color-scheme: dark;/);
  assert.match(colorsCss, /:root\.theme-bright,[\s\S]*--form-control-color-scheme: light;/);
});

test('theme color-scheme reaches app and portal scroll containers', () => {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');
  const hostCss = readFileSync(join(srcDir, 'host.css'), 'utf8');
  const colorsCss = readFileSync(join(srcDir, 'colors.css'), 'utf8');

  assert.match(colorsCss, /--scrollbar-track-bg: var\(--modal-surface-bg\);/);
  assert.match(
    colorsCss,
    /--scrollbar-thumb-bg: color-mix\(in srgb, var\(--foreground\) 28%, var\(--modal-surface-bg\) 72%\);/,
  );

  for (const source of [indexCss, hostCss]) {
    assert.match(
      source,
      /html,[\s\S]*body,[\s\S]*\.app,[\s\S]*\.atlaskit-portal,[\s\S]*\.atlaskit-portal-container\s*{[\s\S]*color-scheme: var\(--form-control-color-scheme\);/,
    );
    assert.match(
      source,
      /\.app,[\s\S]*\.app \*,[\s\S]*\.atlaskit-portal,[\s\S]*\.atlaskit-portal \*,[\s\S]*\.atlaskit-portal-container,[\s\S]*\.atlaskit-portal-container \*\s*{[\s\S]*scrollbar-color: var\(--scrollbar-thumb-bg\) var\(--scrollbar-track-bg\);/,
    );
    assert.match(source, /::-webkit-scrollbar-track[\s\S]*background-color: var\(--scrollbar-track-bg\);/);
    assert.match(source, /::-webkit-scrollbar-corner[\s\S]*background-color: var\(--scrollbar-track-bg\);/);
  }
});

test('app rounded surfaces keep squircle geometry with plain-radius fallback', () => {
  const indexCss = readFileSync(join(srcDir, 'index.css'), 'utf8');
  const nodeStyles = readFileSync(join(srcDir, 'components', 'nodeStyles.ts'), 'utf8');

  assert.match(indexCss, /button\s*{[\s\S]*border-radius: var\(--ui-button-radius\);[\s\S]*corner-shape: squircle;/);
  assert.match(
    indexCss,
    /@supports not \(corner-shape: squircle\)\s*{[\s\S]*--ui-button-radius: calc\(5px \* var\(--ui-font-scale\)\);[\s\S]*--ui-button-radius-sm: calc\(4px \* var\(--ui-font-scale\)\);/,
  );
  assert.match(nodeStyles, /--node-card-radius: calc\(20px \* var\(--ui-font-scale\)\);/);
  assert.match(
    nodeStyles,
    /@supports not \(corner-shape: squircle\)\s*{[\s\S]*--node-card-radius: calc\(10px \* var\(--ui-font-scale\)\);/,
  );
});
