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

test('subgraph node canvas body mirrors graphId with a compact selector', () => {
  assert.match(subGraphNodeSource, /useEditNodeCommand\(\)/);
  assert.match(subGraphNodeSource, /projectState/);
  assert.match(subGraphNodeSource, /getProjectGraphSelectorOptions\(project\.graphs, \{/);
  assert.match(subGraphNodeSource, /aria-label="Subgraph graph"/);
  assert.match(subGraphNodeSource, /<button[\s\S]*?className="subgraph-node-body-select"/);
  assert.doesNotMatch(subGraphNodeSource, /<select[\s\S]*?className="subgraph-node-body-select"/);
  assert.match(subGraphNodeSource, /const menuId = useId\(\)/);
  assert.match(subGraphNodeSource, /aria-controls=\{isMenuOpen \? menuId : undefined\}/);
  assert.match(subGraphNodeSource, /id=\{menuId\}/);
  assert.match(subGraphNodeSource, /role="listbox"/);
  assert.match(subGraphNodeSource, /role="option"/);
  assert.match(subGraphNodeSource, /graphId,/);
  assert.match(subGraphNodeSource, /data: \{[\s\S]*?\.\.\.node\.data[\s\S]*?graphId,/);
  assert.match(subGraphNodeSource, /font-family: var\(--font-family-monospace\);/);
  assert.match(subGraphNodeSource, /background: var\(--node-body-bg\);/);
  assert.match(subGraphNodeSource, /height: calc\(30px \* var\(--ui-font-scale, 1\)\);/);
  assert.doesNotMatch(subGraphNodeSource, /font-weight: 700;/);
  assert.doesNotMatch(subGraphNodeSource, /font-family: var\(--font-family\);/);
});

test('subgraph node canvas selector preserves stale graph ids visibly', () => {
  assert.match(subGraphNodeSource, /includeMissingSelectedGraph: true/);
  assert.match(subGraphNodeSource, /selectedGraphId: node\.data\.graphId/);
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

test('subgraph node selector handles focus and double-click like other canvas controls', () => {
  assert.match(subGraphNodeSource, /const \[isMenuOpen, setIsMenuOpen\] = useState\(false\)/);
  assert.match(subGraphNodeSource, /if \(!isMenuOpen\) \{[\s\S]*?return;[\s\S]*?\}/);
  assert.match(subGraphNodeSource, /document\.addEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
  assert.match(subGraphNodeSource, /document\.addEventListener\('wheel', handleDocumentWheel, true\)/);
  assert.match(subGraphNodeSource, /document\.addEventListener\('keydown', handleDocumentKeyDown, true\)/);
  assert.match(subGraphNodeSource, /rootRef\.current\?\.contains\(event\.target\)/);
  assert.match(
    subGraphNodeSource,
    /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?closeMenu\(\)/,
  );
  assert.match(subGraphNodeSource, /closeMenu\(\)/);
  assert.match(subGraphNodeSource, /document\.removeEventListener\('pointerdown', handleDocumentPointerDown, true\)/);
  assert.match(subGraphNodeSource, /document\.removeEventListener\('wheel', handleDocumentWheel, true\)/);
  assert.match(subGraphNodeSource, /document\.removeEventListener\('keydown', handleDocumentKeyDown, true\)/);
  assert.match(subGraphNodeSource, /onDoubleClick=\{handleControlDoubleClick\}/);
  assert.match(subGraphNodeSource, /onMouseDown=\{handleControlMouseDown\}/);
  assert.match(
    subGraphNodeSource,
    /const handleMenuWheel = \(event: ReactWheelEvent<HTMLDivElement>\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?\}/,
  );
  assert.match(subGraphNodeSource, /onWheel=\{handleMenuWheel\}/);
  assert.match(
    subGraphNodeSource,
    /const handleControlWheel = \(event: ReactWheelEvent<HTMLButtonElement>\) => \{[\s\S]*?if \(!isMenuOpen\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?event\.stopPropagation\(\);[\s\S]*?setIsMenuOpen\(false\);[\s\S]*?\}/,
  );
  assert.match(subGraphNodeSource, /onWheel=\{handleControlWheel\}/);
  assert.doesNotMatch(subGraphNodeSource, /handleOptionDoubleClick/);
  assert.match(subGraphNodeSource, /event\.stopPropagation\(\)/);
});

test('subgraph node descriptor remains registered for custom canvas body rendering', () => {
  assert.match(
    useNodeTypesSource,
    /import \{ subgraphNodeDescriptor \} from '\.\.\/components\/nodes\/SubGraphNode\.js';/,
  );
  assert.match(useNodeTypesSource, /subGraph: subgraphNodeDescriptor,/);
});
