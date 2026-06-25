import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));
const appSrcDir = resolve(componentsDir, '..');

test('blank canvas context menu labels node creation affordances explicitly', () => {
  const contextMenuComponentSource = readFileSync(join(componentsDir, 'ContextMenu.tsx'), 'utf8');
  const contextMenuSource = readFileSync(join(appSrcDir, 'hooks', 'useContextMenuConfiguration.ts'), 'utf8');

  const addMenuItem = contextMenuSource.match(
    /blankArea:[\s\S]*?id: 'add'[\s\S]*?items: addMenuConfig,[\s\S]*?icon: PlusIcon,/,
  );

  assert.ok(addMenuItem, 'expected blank canvas add menu item to exist');
  assert.match(addMenuItem[0], /label: 'Add node'/);
  assert.doesNotMatch(addMenuItem[0], /label: 'Add'/);
  assert.match(
    contextMenuComponentSource,
    /context\.type === 'blankArea' \? 'Type in node name\.\.\.' : 'Search\.\.\.'/,
  );
  assert.match(contextMenuComponentSource, /placeholder=\{searchPlaceholder\}/);
  assert.match(
    contextMenuComponentSource,
    /\.context-menu-search \{[\s\S]*input \{[\s\S]*background-color: transparent !important;[\s\S]*border: 0 !important;[\s\S]*border-width: 0 !important;[\s\S]*box-shadow: none !important;/,
  );
});

test('canvas context menu hover uses the shared popup-menu row hover fill', () => {
  const contextMenuComponentSource = readFileSync(join(componentsDir, 'ContextMenu.tsx'), 'utf8');

  assert.match(
    contextMenuComponentSource,
    /&:hover,[\s\S]*&\.active \{[\s\S]*background-color: var\(--popup-menu-row-hover-bg\);/,
  );
  assert.doesNotMatch(contextMenuComponentSource, /background-color: rgba\(255, 255, 255, 0\.1\);/);
});
