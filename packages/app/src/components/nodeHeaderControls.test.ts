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

test('linked node headers use the library-link control instead of the edit gear', () => {
  const nodeBodySource = readFileSync(join(componentsDir, 'NodeBody.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const subGraphHeaderLinkSource = readFileSync(join(componentsDir, 'visualNode', 'SubGraphHeaderLink.tsx'), 'utf8');
  const visualNodeSource = readFileSync(join(componentsDir, 'VisualNode.tsx'), 'utf8');
  const normalNodeSource = readFileSync(join(componentsDir, 'visualNode', 'NormalVisualNodeContent.tsx'), 'utf8');
  const zoomedOutNodeSource = readFileSync(join(componentsDir, 'visualNode', 'ZoomedOutVisualNodeContent.tsx'), 'utf8');
  const splitRunSummarySource = readFileSync(join(componentsDir, 'visualNode', 'SplitRunSummary.tsx'), 'utf8');
  const contextMenuConfigurationSource = readFileSync(
    join(componentsDir, '..', 'hooks', 'useContextMenuConfiguration.ts'),
    'utf8',
  );

  assert.match(visualNodeSource, /const nodeForEditing = editTargetNode \?\? node;/);
  assert.match(visualNodeSource, /onNodeStartEditing\?\.\(nodeForEditing\);/);
  assert.match(visualNodeSource, /editTargetNode=\{props\.node\}/);
  assert.match(nodeBodySource, /interactive = true/);
  assert.match(nodeBodySource, /'aria-disabled': true/);
  assert.match(nodeBodySource, /inert: true/);
  assert.match(nodeBodySource, /\.\.\.readOnlyAttributes/);
  assert.match(nodeBodySource, /'node-body-readonly': !interactive/);
  assert.match(nodeStylesSource, /\.node-body-readonly \{[\s\S]*pointer-events: none;/);
  assert.match(
    nodeStylesSource,
    /\.node-prefab-instance-indicator \{[\s\S]*width: calc\(26px \* var\(--ui-font-scale\)\);[\s\S]*\}/,
  );
  assert.match(nodeStylesSource, /\.node-prefab-instance-indicator:hover \{[\s\S]*color: var\(--primary-text\);/);

  for (const source of [normalNodeSource, zoomedOutNodeSource]) {
    assert.match(source, /isNodePrefabInstance && \(/);
    assert.match(source, /className=\{clsx\('grab-area', \{ 'has-subgraph-header-link': node\.type === 'subGraph' \}\)\}/);
    assert.match(source, /className="node-prefab-instance-indicator"/);
    assert.match(source, /aria-label="Open library node"/);
    assert.match(source, /onClick=\{handleEditClick\}/);
    assert.match(source, /onNodeStartEditing\?\.\(editTargetNode \?\? node\);/);
    assert.match(source, /<SplitRunSummary node=\{node\} editTargetNode=\{editTargetNode\}/);
    assert.match(source, /!\s*isNodePrefabInstance && \([\s\S]*className="edit-button"/);
  }
  assert.match(normalNodeSource, /interactive=\{!isNodePrefabInstance\}/);

  assert.match(splitRunSummarySource, /onNodeStartEditing\?\.\(editTargetNode \?\? node\);/);
  assert.match(subGraphHeaderLinkSource, /SubgraphGraphIcon/);
  assert.doesNotMatch(subGraphHeaderLinkSource, /SubgraphLinkIcon/);
  assert.match(
    nodeStylesSource,
    /\.subgraph-link-tooltip \{[\s\S]*position: absolute;[\s\S]*top: 0;[\s\S]*bottom: 0;[\s\S]*left: 0;[\s\S]*width: calc\(41px \* var\(--ui-font-scale\)\);[\s\S]*\}/,
  );
  assert.match(
    nodeStylesSource,
    /\.subgraph-link-button \{[\s\S]*position: relative;[\s\S]*width: 100%;[\s\S]*height: 100%;[\s\S]*\}/,
  );
  assert.match(
    nodeStylesSource,
    /\.subgraph-link-button \{[\s\S]*svg \{[\s\S]*position: absolute;[\s\S]*left: calc\(12px \* var\(--ui-font-scale\)\);[\s\S]*top: calc\(12px \* var\(--ui-font-scale\)\);[\s\S]*\}/,
  );
  assert.match(
    nodeStylesSource,
    /\.grab-area\.has-subgraph-header-link \{[\s\S]*padding-left: calc\(27px \* var\(--ui-font-scale\)\);[\s\S]*\}/,
  );
  assert.match(
    contextMenuConfigurationSource,
    /id: 'node-go-to-subgraph',[\s\S]*label: 'Go to subgraph',[\s\S]*icon: SubgraphGraphIcon,/,
  );
  assert.match(
    contextMenuConfigurationSource,
    /id: 'node-open-prefab-source',[\s\S]*label: 'Open library node',[\s\S]*icon: SubgraphLinkIcon,/,
  );

  assert.match(contextMenuConfigurationSource, /const canEditNode = \(context: unknown\) =>/);
  assert.match(
    contextMenuConfigurationSource,
    /id: 'node-edit',[\s\S]*label: 'Edit',[\s\S]*icon: SettingsCogIcon,[\s\S]*conditional: canEditNode,/,
  );
});
