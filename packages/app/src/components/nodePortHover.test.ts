import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('port hover keeps the parent node hover presentation active', () => {
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');

  assert.match(
    nodeCanvasSource,
    /const onPortMouseOver = useStableCallback\([\s\S]*?setHoveringNode\(nodeId\);[\s\S]*?showPortTooltip\(event, nodeId, isInput, portId, definition\);/,
  );
  assert.doesNotMatch(nodeCanvasSource, /hoveredNodeId=\{hoveringPort \? undefined : hoveringNode\}/);
  assert.equal([...nodeCanvasSource.matchAll(/hoveredNodeId=\{hoveringNode\}/g)].length, 2);
});

test('port info tooltip does not steal hover from the port', () => {
  const portInfoSource = readFileSync(join(componentsDir, 'PortInfo.tsx'), 'utf8');

  assert.match(portInfoSource, /pointer-events:\s*none;/);
});

test('port info tooltip uses the shared canvas process-page default', () => {
  const portInfoSource = readFileSync(join(componentsDir, 'PortInfo.tsx'), 'utf8');

  assert.match(portInfoSource, /selectedProcessPageNodesState/);
  assert.match(portInfoSource, /resolveCanvasExecutionProcessPage\(selectedProcessPageNodes\[port\.nodeId\]\)/);
  assert.doesNotMatch(portInfoSource, /selectedProcessPageState\(port\.nodeId\)/);
});
