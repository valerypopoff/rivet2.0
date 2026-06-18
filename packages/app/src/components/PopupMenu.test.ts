import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

test('shared popup menu surfaces use the translucent blurred theme-tinted material', () => {
  const popupMenuSource = readFileSync(join(srcDir, 'PopupMenu.tsx'), 'utf8');

  assert.match(
    popupMenuSource,
    /export const popupMenuSurfaceStyles = css`[\s\S]*background-color: var\(--grey-dark-colorish-seethrough\);/,
  );
  assert.match(popupMenuSource, /backdrop-filter: blur\(2px\);/);
  assert.match(popupMenuSource, /-webkit-backdrop-filter: blur\(2px\);/);
  assert.match(popupMenuSource, /border: 1px solid var\(--settings-collapsible-border\);/);
  assert.doesNotMatch(popupMenuSource, /border: 2px solid var\(--grey-dark\);/);
  assert.doesNotMatch(popupMenuSource, /background-color: var\(--grey-dark-colorish\);/);
  assert.doesNotMatch(popupMenuSource, /background-color: var\(--foreground-on-primary\);/);
});

test('shared popup menu row hover matches graph tree hover fill', () => {
  const popupMenuSource = readFileSync(join(srcDir, 'PopupMenu.tsx'), 'utf8');

  assert.match(
    popupMenuSource,
    /&:hover,[\s\S]*&:focus-visible,[\s\S]*&\.active \{[\s\S]*background-color: var\(--grey-darkish\);/,
  );
  assert.doesNotMatch(popupMenuSource, /background-color: rgba\(255, 255, 255, 0\.1\);/);
});

test('shared popup menu separators use a theme-controlled token', () => {
  const colorsSource = readFileSync(join(srcDir, '..', 'colors.css'), 'utf8');
  const popupMenuSource = readFileSync(join(srcDir, 'PopupMenu.tsx'), 'utf8');
  const contextMenuSource = readFileSync(join(srcDir, 'ContextMenu.tsx'), 'utf8');

  assert.match(colorsSource, /--popup-menu-separator: var\(--grey-dark\);/);
  assert.match(
    colorsSource,
    /:root\.theme-bright,[\s\S]*--popup-menu-separator: color-mix\(in srgb, var\(--secondary\) 8%, #bac5d2 92%\);/,
  );
  assert.match(popupMenuSource, /background-color: var\(--popup-menu-separator\);/);
  assert.match(contextMenuSource, /border-top: 1px solid var\(--popup-menu-separator\);/);
});
