import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));
const readComponent = (...parts: string[]) => readFileSync(join(componentsDir, ...parts), 'utf8');

test('graph tree shell delegates header, resources, context menus, and dialogs', () => {
  const source = readComponent('GraphList.tsx');

  assert.match(source, /<GraphListHeader/);
  assert.match(source, /<UiGraphResourceSection/);
  assert.match(source, /<GraphListContextMenus/);
  assert.match(source, /<GraphListDialogs/);
  assert.match(source, /<FolderItem/);
  assert.match(source, /useGraphListPresentation/);
  assert.match(source, /useUiGraphOperations/);
});

test('graph tree header preserves action order, filter behavior, and Node library count', () => {
  const header = readComponent('graphList', 'GraphListHeader.tsx');
  const filterFocus = readComponent('graphList', 'graphFilterFocus.ts');

  assert.match(
    header,
    /<span>Search<\/span>[\s\S]*<span>Project settings<\/span>[\s\S]*<span>Node library<\/span>[\s\S]*className="graph-list-filter"/,
  );
  assert.doesNotMatch(header, /Node Library/);
  assert.match(header, /aria-current=\{nodeLibraryOpen \? 'page' : undefined\}/);
  assert.match(header, /nodeLibraryItemCount > 0/);
  assert.match(header, /\{\.\.\.GRAPH_FILTER_INPUT_MARKER\}/);
  assert.match(header, /aria-label="Filter graphs"/);
  assert.match(filterFocus, /GRAPH_FILTER_INPUT_MARKER/);
});

test('graph tree styles keep compact selected and reachability presentation', () => {
  const source = readComponent('GraphList.tsx');
  const noticeStyles = source.match(/\.graph-list-notice \{(?<styles>[\s\S]*?)\n  \}/)?.groups?.styles;

  assert.match(source, /\.graph-list-toolbar \{[\s\S]*gap: 16px;/);
  assert.match(source, /\.graph-list-action\.selected::before \{[\s\S]*background-color: var\(--primary\);/);
  assert.match(source, /\.graph-list-action\.selected \.graph-folder-count \{[\s\S]*color: var\(--primary\);/);
  assert.match(source, /\.graph-folder-count \{[\s\S]*transform: translateY\(-1px\);/);
  assert.ok(noticeStyles);
  assert.doesNotMatch(noticeStyles, /border:|var\(--warning/);
});

test('folder rows keep accessible unreachable diagnostics and stable indentation', () => {
  const source = readComponent('graphList', 'FolderItem.tsx');

  assert.match(source, /'--graph-item-indent': `\$\{virtualDepth \* 20\}px`/);
  assert.match(source, /content="This graph is unreachable from the Main Graph\."/);
  assert.match(source, /aria-label="Unreachable graph"/);
  assert.match(source, /<UnreachableGraphIcon aria-hidden="true" \/>/);
  assert.match(source, /addEventListener\('pointerdown', handleOutsidePointerDown, true\)/);
});

test('Node library empty state centers in the canvas area and explains linked nodes', () => {
  const source = readComponent('NodeLibraryBuilder.tsx');

  assert.match(source, /leftSidebarLiveWidthState/);
  assert.match(source, /Right-click to add library nodes\./);
  assert.match(source, /Library nodes are reusable sources\./);
  assert.match(
    source,
    /left: calc\(var\(--node-library-sidebar-offset\) \+ \(100% - var\(--node-library-sidebar-offset\)\) \/ 2\);/,
  );
});
