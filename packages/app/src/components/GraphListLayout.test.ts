import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('graph tree panel keeps the compact text-list layout source contract', () => {
  const graphListSource = readFileSync(join(componentsDir, 'GraphList.tsx'), 'utf8');
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');
  const folderItemSource = readFileSync(join(componentsDir, 'graphList', 'FolderItem.tsx'), 'utf8');
  const graphFilterFocusSource = readFileSync(join(componentsDir, 'graphList', 'graphFilterFocus.ts'), 'utf8');
  const graphListContextMenuSource = readFileSync(join(componentsDir, 'graphList', 'graphListContextMenu.ts'), 'utf8');

  // This remains a narrow source guard because the project tree is not covered by a render/screenshot test yet.
  // Behavior such as context-menu targeting, folder presentation, reachability, and running state is covered in
  // graph-list helper tests.
  assert.match(graphListSource, /className="project-tree-panel-header"/);
  const panelHeaderStyles = graphListSource.match(/\.project-tree-panel-header \{(?<styles>[\s\S]*?)\n  \}/)
    ?.groups?.styles;
  assert.ok(panelHeaderStyles);
  assert.doesNotMatch(panelHeaderStyles, /background(?:-color)?:/);
  assert.match(graphListSource, /className="project-tree-header"/);
  assert.doesNotMatch(graphListSource, /project-tree-header-tooltip|content={project\.metadata\.title}/);
  assert.doesNotMatch(graphListSource, /className="project-tree-header" title=/);
  assert.match(graphListSource, /<span className="project-tree-header-label">Project:<\/span>/);
  assert.match(graphListSource, /content="Search \(Ctrl\/Cmd\+F\)"/);
  assert.match(graphListSource, /setGraphSearch\(openOrFocusGraphSearchState\)/);
  assert.match(graphListSource, /<span>Search<\/span>[\s\S]*<span>Project settings<\/span>/);
  assert.match(graphListSource, /className="graph-list-action"/);
  assert.match(graphListSource, /color: var\(--grey-lightest\);/);
  assert.match(
    graphListSource,
    /\.graph-list-action,\s+\.graph-list-filter-label \{[\s\S]*min-height: calc\(20px \* var\(--ui-font-scale\)\);[\s\S]*padding: 0;/,
  );
  assert.match(
    graphListSource,
    /\.graph-list-action::before,\s+\.graph-list-filter-label::before \{[\s\S]*inset: -7px -10px;[\s\S]*border-radius: 10px;/,
  );
  assert.match(
    graphListSource,
    /\.graph-list-action:hover::before,\s+\.graph-list-filter:hover \.graph-list-filter-label::before,\s+\.graph-list-filter:focus-within \.graph-list-filter-label::before \{[\s\S]*background-color: var\(--grey-darkish\);/,
  );
  assert.match(graphListSource, /\.graph-list-toolbar \{[\s\S]*gap: 16px;/);
  assert.match(graphListSource, /className="graph-list-heading">Graphs<\/div>/);
  assert.match(graphListSource, /\.graph-list-heading \{[\s\S]*color: color-mix\(in srgb, var\(--grey-light\) 64%, transparent\);/);
  assert.match(graphListSource, /<span>Project settings<\/span>/);
  assert.match(graphListSource, /className="graph-list-filter"/);
  assert.match(graphListSource, /import \{ GRAPH_FILTER_INPUT_MARKER \} from '\.\/graphList\/graphFilterFocus\.js';/);
  assert.match(graphListSource, /<input\s+\{...GRAPH_FILTER_INPUT_MARKER\}/);
  assert.match(graphListSource, /aria-label="Filter graphs"/);
  assert.match(graphListSource, /placeholder="Filter graphs"/);
  assert.match(
    graphListSource,
    /\.graph-list-filter input \{[\s\S]*border: 0 !important;[\s\S]*border-width: 0 !important;[\s\S]*box-shadow: none !important;[\s\S]*background: transparent !important;/,
  );
  assert.match(nodeCanvasSource, /import \{ blurFocusedGraphFilterInput \} from '\.\/graphList\/graphFilterFocus\.js';/);
  assert.match(
    nodeCanvasSource,
    /const handleCanvasMouseDownCapture = useStableCallback\(\(event: MouseEvent<HTMLDivElement>\) => \{\s+blurFocusedGraphFilterInput\(event\.currentTarget\.ownerDocument\);/,
  );
  assert.match(nodeCanvasSource, /onMouseDownCapture={handleCanvasMouseDownCapture}/);
  assert.match(graphFilterFocusSource, /GRAPH_FILTER_INPUT_MARKER = \{ 'data-graph-filter-input': 'true' \}/);
  assert.match(graphFilterFocusSource, /resolvedDocument\.defaultView\?\.HTMLElement/);
  assert.match(graphFilterFocusSource, /activeElement instanceof HTMLElementCtor && activeElement\.matches\(GRAPH_FILTER_INPUT_SELECTOR\)/);
  assert.match(graphListSource, /data-contextmenutype="graph-list"/);
  assert.match(graphListSource, /onKeyDown={handleGraphListKeyDown}/);
  assert.match(graphListSource, /onMouseDown={handleGraphListMouseDown}/);
  assert.match(graphListSource, /onMouseDownCapture={handleGraphListMouseDownCapture}/);
  assert.match(graphListSource, /tabIndex={-1}/);
  assert.match(graphListSource, /if \(e\.button !== 0\) {\s+return;\s+}/);
  assert.match(graphListSource, /if \(e\.button !== 0\) {\s+e\.preventDefault\(\);/);
  assert.doesNotMatch(graphListSource, /ref={refs\.setReference}/);
  assert.match(graphListSource, /ref={setFloatingMenu}/);
  assert.match(graphListSource, /e\.key !== 'F2'/);
  assert.match(graphListSource, /isInteractiveGraphListTarget\(e\.target\)/);
  assert.match(graphListSource, /setSearchText\(''\);/);
  assert.match(graphListSource, /\.clear \{[\s\S]*z-index: 2;[\s\S]*cursor: pointer;/);
  assert.match(graphListSource, /startRename\(currentGraphListName\)/);
  assert.match(graphListSource, /cancelRename/);
  assert.match(graphListSource, /<PopupMenuItem\b/);
  assert.match(graphListSource, /setAllGraphFolderExpansionStates/);
  assert.match(graphListSource, /handleFolderExpansionMenuSelected/);
  assert.doesNotMatch(graphListSource, /from '\.\/ContextMenu'/);
  assert.doesNotMatch(graphListSource, /<ContextMenuItem\b/);
  assert.match(graphListContextMenuSource, /export type GraphListContextMenuItem =/);
  assert.doesNotMatch(graphListContextMenuSource, /useContextMenuConfiguration/);
  assert.match(graphListContextMenuSource, /id: 'collapse-all-folders'[\s\S]*label: 'Collapse all folders'/);
  assert.match(graphListContextMenuSource, /id: 'expand-all-folders'[\s\S]*label: 'Expand all folders'/);
  assert.match(graphListContextMenuSource, /hasFolders/);
  assert.match(graphListSource, /&:focus::placeholder {\s+opacity: 0;\s+}/);
  assert.match(graphListSource, /\.graph-list-action {\s+cursor: pointer;\s+isolation: isolate;\s+}/);
  assert.match(graphListSource, /\.graph-list-toolbar \{[\s\S]*--project-tree-panel-icon-color: [^;]+;/);
  assert.match(
    graphListSource,
    /\.project-tree-panel-icon \{[^}]*color: var\(--project-tree-panel-icon-color, currentColor\);[^}]*--project-tree-panel-icon-size/s,
  );
  assert.match(graphListSource, /\.project-tree-panel-icon-search \{[^}]*--project-tree-panel-icon-y:/s);
  assert.match(graphListSource, /\.project-tree-panel-icon-project-settings \{[^}]*--project-tree-panel-icon-y:/s);
  assert.match(graphListSource, /\.project-tree-panel-icon-filter \{[^}]*--project-tree-panel-icon-y:/s);
  assert.match(
    graphListSource,
    /\.project-tree-panel-icon-filter-clear \{[^}]*--project-tree-panel-icon-size: 12px;/s,
  );
  assert.doesNotMatch(
    graphListSource,
    /\.project-tree-panel-icon-(search|project-settings|filter|filter-clear) \{[^}]*--project-tree-panel-icon-color:/s,
  );
  assert.match(
    graphListSource,
    /<SearchIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-search" \/>/,
  );
  assert.match(graphListSource, /className="project-tree-panel-icon project-tree-panel-icon-project-settings"/);
  assert.match(
    graphListSource,
    /<FilterIcon aria-hidden="true" className="project-tree-panel-icon project-tree-panel-icon-filter" \/>/,
  );
  assert.match(graphListSource, /project-tree-panel-icon-filter-clear/);
  assert.match(graphListSource, /\.spinner \.node-running-indicator {\s+width: var\(--ui-font-size-base\);/);
  assert.match(
    graphListSource,
    /\.graph-main-icon {\s+width: 1em;\s+height: 1em;[\s\S]*transform: translateY\(-1px\);/,
  );
  assert.match(
    graphListSource,
    /--collapsed-open-graph-folder-color: color-mix\(in srgb, var\(--primary\) 28%, transparent\);/,
  );
  assert.match(
    graphListSource,
    /\.contains-open-graph \.graph-item-select {\s+background-color: var\(--collapsed-open-graph-folder-color\);/,
  );
  assert.match(
    graphListSource,
    /\.graph-reference-dot\.folder-reference-dot {\s+background: var\(--collapsed-open-graph-folder-color\);/,
  );
  assert.doesNotMatch(graphListSource, /graph-item-tooltip/);
  assert.doesNotMatch(graphListSource, /metadata!/);
  assert.match(graphListSource, /padding: 8px 10px 8px calc\(10px \+ var\(--graph-item-indent, 0px\)\);/);
  assert.match(graphListSource, /\.folder-children\.with-guide-line::before/);
  assert.match(graphListSource, /left: calc\(10px \+ var\(--graph-item-indent, 0px\) \+ 7px\);/);
  assert.match(graphListSource, /\.folder-children\.with-guide-line::before {[\s\S]*z-index: 1;/);
  assert.doesNotMatch(graphListSource, /iconBefore=|shouldFitContainer/);

  assert.match(folderItemSource, /'--graph-item-indent': `\$\{virtualDepth \* 20\}px`/);
  assert.match(folderItemSource, /containsReferencingSelectedGraph/);
  assert.match(folderItemSource, /'folder-reference-dot': containsReferencingSelectedGraph/);
  assert.match(folderItemSource, /onCancel={onCancelRename}/);
  assert.match(folderItemSource, /onBlur={handleRenameBlur}/);
  assert.match(folderItemSource, /addEventListener\('pointerdown', handleOutsidePointerDown, true\)/);
  assert.match(folderItemSource, /e\.key === 'Escape'/);
  assert.match(folderItemSource, /onCancel\(\);/);
  assert.match(
    folderItemSource,
    /const showChildGuideLine = item\.type === 'folder' && isExpanded && item\.children\.length > 0/,
  );
  assert.match(folderItemSource, /'with-guide-line': showChildGuideLine/);
  assert.match(folderItemSource, /style={folderItemStyle}/);
  assert.doesNotMatch(folderItemSource, /style={graphItemStyle}/);
  assert.match(
    folderItemSource,
    /position: 'relative'[\s\S]*transform: `translate3d\(0, \$\{transform\.y\}px, 0\)`[\s\S]*zIndex: 100/,
  );
  assert.doesNotMatch(folderItemSource, /<Tooltip|GraphItemTooltipContent|title\.split\('\\n'\)\.map/);
  assert.doesNotMatch(folderItemSource, /<div[^>]*title={title}/);
  assert.doesNotMatch(folderItemSource, /className="unreachable-badge" title=/);
  assert.doesNotMatch(folderItemSource, /depthSpacer|range\(/);
});
