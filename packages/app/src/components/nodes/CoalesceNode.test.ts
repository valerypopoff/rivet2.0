import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const coalesceNodeSource = readFileSync(new URL('./CoalesceNode.tsx', import.meta.url), 'utf8');
const useNodeTypesSource = readFileSync(new URL('../../hooks/useNodeTypes.ts', import.meta.url), 'utf8');

test('coalesce node uses canvas toggles for ignore-null and ignore-undefined settings', () => {
  assert.match(coalesceNodeSource, /useEditNodeCommand\(\)/);
  assert.match(coalesceNodeSource, /dataKey: 'ignoreNull'/);
  assert.match(coalesceNodeSource, /dataKey: 'ignoreUndefined'/);
  assert.match(coalesceNodeSource, /label: 'Ignore null'/);
  assert.match(coalesceNodeSource, /label: 'Ignore undefined'/);
  assert.match(coalesceNodeSource, /ariaLabel: "Ignore 'null'"/);
  assert.match(coalesceNodeSource, /ariaLabel: "Ignore 'undefined'"/);
  assert.match(coalesceNodeSource, /font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(coalesceNodeSource, /font-family: var\(--font-family\);/);
  assert.match(coalesceNodeSource, /font-family: inherit !important;/);
  assert.match(coalesceNodeSource, /font-size: inherit !important;/);
  assert.match(coalesceNodeSource, /gap: calc\(9px \* var\(--ui-font-scale, 1\)\);/);
  assert.match(coalesceNodeSource, /aspect-ratio: 2 \/ 1;/);
  assert.match(coalesceNodeSource, /line-height: 0;/);
  assert.match(coalesceNodeSource, /const toggleIdBase = useId\(\);/);
  assert.match(coalesceNodeSource, /<ScalableToggle[\s\S]*?isChecked=\{node\.data\[toggle\.dataKey\] === true\}/);
  assert.match(coalesceNodeSource, /id=\{toggleInputId\}/);
  assert.match(coalesceNodeSource, /htmlFor=\{toggleInputId\}/);
  assert.doesNotMatch(coalesceNodeSource, /\.coalesce-node-body-row\s*{[\s\S]*?gap:/);
  assert.match(
    coalesceNodeSource,
    /\.coalesce-node-body-label\s*{[\s\S]*?padding-left: calc\(7px \* var\(--ui-font-scale, 1\)\);/,
  );
  assert.match(coalesceNodeSource, /cursor: pointer;/);
  assert.doesNotMatch(coalesceNodeSource, /size="large"/);
  assert.match(coalesceNodeSource, /\[dataKey\]: event\.target\.checked/);
});

test('coalesce node canvas controls use normal node edit and control-only double-click handling', () => {
  assert.match(coalesceNodeSource, /nodeId: node\.id/);
  assert.match(coalesceNodeSource, /data: \{[\s\S]*?\.\.\.node\.data[\s\S]*?\[dataKey\]: event\.target\.checked/);
  assert.match(coalesceNodeSource, /className="coalesce-node-body-toggle-wrap" onDoubleClick=\{handleToggleDoubleClick\}/);
  assert.match(coalesceNodeSource, /className="coalesce-node-body-label"[\s\S]*?onDoubleClick=\{handleToggleDoubleClick\}/);
  assert.match(coalesceNodeSource, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(coalesceNodeSource, /<div css=\{styles\} onDoubleClick=/);
});

test('both coalesce node types are registered for custom canvas body rendering', () => {
  assert.match(
    useNodeTypesSource,
    /import \{ coalesceNewNodeDescriptor, coalesceNodeDescriptor \} from '\.\.\/components\/nodes\/CoalesceNode\.js';/,
  );
  assert.match(useNodeTypesSource, /coalesce: coalesceNodeDescriptor,/);
  assert.match(useNodeTypesSource, /coalesceNew: coalesceNewNodeDescriptor,/);
});
