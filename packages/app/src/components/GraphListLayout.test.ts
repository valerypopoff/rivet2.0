import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));
const readComponent = (...parts: string[]) => readFileSync(join(componentsDir, ...parts), 'utf8');

test('graph tree shell delegates header, resources, context menus, and dialogs', () => {
  const source = readComponent('GraphList.tsx');
  const uiGraphResources = readComponent('graphList', 'UiGraphResourceSection.tsx');

  assert.match(source, /<GraphListHeader/);
  assert.match(source, /<UiGraphResourceSection/);
  assert.match(source, /referencingSelectedUiGraphIds=\{referencingSelectedUiGraphIds\}/);
  assert.match(uiGraphResources, /referencingSelectedUiGraphIds\.has\(uiGraph\.id\)/);
  assert.match(uiGraphResources, /className="graph-reference-dot"/);
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
  assert.match(source, /\.graph-reference-dot \{[\s\S]*left: 0;/);
});

test('web app resource names shrink and truncate within the graph panel', () => {
  const source = readComponent('GraphList.tsx');

  assert.match(source, /\.graph-list-container \{[\s\S]*min-width: 0;/);
  assert.match(source, /\.ui-graph-list \{[\s\S]*min-width: 0;/);
  assert.match(source, /\.ui-graph-entry,[\s\S]*\.ui-graph-create \{[\s\S]*width: 100%;[\s\S]*min-width: 0;/);
  assert.match(
    source,
    /\.ui-graph-entry-name \{[\s\S]*flex: 1 1 auto;[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis;/,
  );
});

test('web app resources keep the same section gap as the project header', () => {
  const source = readComponent('GraphList.tsx');

  assert.match(source, /\.project-tree-panel-header \{[\s\S]*padding: 16px 18px 25px;/);
  assert.match(source, /\.project-tree-panel-header \{[\s\S]*margin: -16px -8px 9px;/);
  assert.match(source, /\.ui-graph-list \{[\s\S]*margin: 0 0 34px;/);
});

test('folder rows keep accessible unreachable diagnostics and stable indentation', () => {
  const source = readComponent('graphList', 'FolderItem.tsx');

  assert.match(source, /'--graph-item-indent': `\$\{virtualDepth \* 20\}px`/);
  assert.match(source, /content="This graph is not reachable from the Main Graph or a web app\."/);
  assert.match(source, /aria-label="Unreachable graph"/);
  assert.match(source, /<UnreachableGraphIcon aria-hidden="true" \/>/);
  assert.match(source, /addEventListener\('pointerdown', handleOutsidePointerDown, true\)/);
});

test('graph settings explain web-app-aware reachability and reference indicators', () => {
  const source = readComponent('settings', 'pages', 'GraphsSettingsPage.tsx');

  assert.match(source, /Main Graph or a web app action/);
  assert.match(source, /graphs and web apps that directly reference the currently open graph/);
  assert.match(source, /label="Graph Builder implementation"/);
  assert.match(source, /changes affect only new sessions/);
  assert.match(source, /value: 'plan-b'/);
  assert.match(source, /value: 'legacy'/);
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
