import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const subGraphNodeSource = readFileSync(new URL('./SubGraphNode.tsx', import.meta.url), 'utf8');
const useNodeTypesSource = readFileSync(new URL('../../hooks/useNodeTypes.ts', import.meta.url), 'utf8');
const coreSubGraphNodeSource = readFileSync(
  new URL('../../../../core/src/model/nodes/SubGraphNode.ts', import.meta.url),
  'utf8',
);

test('subgraph node keeps the settings-panel graph selector as the source editor', () => {
  assert.match(coreSubGraphNodeSource, /type: 'graphSelector'/);
  assert.match(coreSubGraphNodeSource, /label: 'Graph'/);
  assert.match(coreSubGraphNodeSource, /dataKey: 'graphId'/);
});

test('subgraph node canvas body reuses the searchable settings selector', () => {
  assert.match(subGraphNodeSource, /useEditNodeCommand\(\)/);
  assert.match(subGraphNodeSource, /import \{ GraphSelectorSelect \} from '\.\.\/editors\/GraphSelectorEditor\.js';/);
  assert.match(subGraphNodeSource, /<GraphSelectorSelect[\s\S]*?ariaLabel="Subgraph graph"/);
  assert.match(subGraphNodeSource, /className="subgraph-node-body-select"/);
  assert.match(subGraphNodeSource, /includeMissingSelectedGraph/);
  assert.match(subGraphNodeSource, /graphId,/);
  assert.match(subGraphNodeSource, /data: \{[\s\S]*?\.\.\.node\.data[\s\S]*?graphId,/);
  assert.match(subGraphNodeSource, /\.subgraph-node-body-select \{[\s\S]*?width: 100%;/);
  assert.doesNotMatch(subGraphNodeSource, /subgraph-node-body-select__option/);
});

test('subgraph node canvas selector preserves stale graph ids visibly', () => {
  assert.match(subGraphNodeSource, /includeMissingSelectedGraph/);
  assert.match(subGraphNodeSource, /value=\{node\.data\.graphId\}/);
});

test('subgraph node canvas body displays enabled output pruning after its graph selector only', () => {
  assert.match(subGraphNodeSource, /node\.data\.skipUnusedOutputs === true/);
  assert.match(subGraphNodeSource, /data-testid="subgraph-skip-unused-outputs"/);
  assert.match(subGraphNodeSource, /Skip unused outputs:<\/span> Enabled/);
  assert.match(subGraphNodeSource, /subgraph-node-body-setting-label[\s\S]*?opacity: 0\.55;/);
  assert.match(
    subGraphNodeSource,
    /subgraph-node-body-select-wrap[\s\S]*?<\/div>\s*\{node\.data\.skipUnusedOutputs === true/,
  );
});

test('subgraph node selector keeps canvas pointer and keyboard interactions isolated', () => {
  assert.match(subGraphNodeSource, /onDoubleClick=\{handleControlDoubleClick\}/);
  assert.match(subGraphNodeSource, /onMouseDown=\{handleControlMouseDown\}/);
  assert.match(subGraphNodeSource, /onPointerDown=\{handleControlPointerDown\}/);
  assert.match(subGraphNodeSource, /onWheel=\{handleMenuWheel\}/);
  assert.match(subGraphNodeSource, /onKeyDown=\{handleControlKeyDown\}/);
  assert.match(subGraphNodeSource, /event\.stopPropagation\(\)/);
});

test('subgraph node descriptor remains registered for custom canvas body rendering', () => {
  assert.match(
    useNodeTypesSource,
    /import \{ subgraphNodeDescriptor \} from '\.\.\/components\/nodes\/SubGraphNode\.js';/,
  );
  assert.match(useNodeTypesSource, /subGraph: subgraphNodeDescriptor,/);
});
