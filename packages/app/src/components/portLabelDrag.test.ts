import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canStartWireDragFromPortLabel, isPrimaryPortMouseButton } from './Port.js';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('canStartWireDragFromPortLabel only allows wire starts from output labels', () => {
  assert.equal(canStartWireDragFromPortLabel(false), true);
  assert.equal(canStartWireDragFromPortLabel(true), false);
});

test('port mouse gestures only use the primary mouse button', () => {
  assert.equal(isPrimaryPortMouseButton(0), true);
  assert.equal(isPrimaryPortMouseButton(1), false);
  assert.equal(isPrimaryPortMouseButton(2), false);
});

test('conditional node ports render the if label outside the port and over connected wires', () => {
  const portSource = readFileSync(join(componentsDir, 'Port.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const conditionalIfPortSource = readFileSync(join(componentsDir, 'visualNode', 'ConditionalIfPort.tsx'), 'utf8');
  const normalNodeSource = readFileSync(join(componentsDir, 'visualNode', 'NormalVisualNodeContent.tsx'), 'utf8');
  const zoomedOutNodeSource = readFileSync(join(componentsDir, 'visualNode', 'ZoomedOutVisualNodeContent.tsx'), 'utf8');
  const connectedLabelStyleBlock = nodeStylesSource.match(/\.conditional-if-port-label\.connected \{(?<body>[\s\S]*?)\n  \}/)
    ?.groups?.body;

  assert.match(portSource, /hideLabel = false/);
  assert.match(portSource, /!\s*hideLabel && \(/);
  assert.match(normalNodeSource, /\{node\.isConditional && <ConditionalIfPort node=\{node\} connections=\{connections\} \/>}/);
  assert.match(
    zoomedOutNodeSource,
    /\{node\.isConditional && <ConditionalIfPort node=\{node\} connections=\{connections\} \/>}/,
  );
  assert.match(conditionalIfPortSource, /className="node-title-ports conditional-if-port input-ports"/);
  assert.match(conditionalIfPortSource, /className=\{clsx\('conditional-if-port-label', \{ connected: ifConnected \}\)\}/);
  assert.match(conditionalIfPortSource, /title="if"[\s\S]*hideLabel[\s\S]*input/);
  assert.match(nodeStylesSource, /\.conditional-if-port-label \{[\s\S]*?position: absolute;/);
  assert.match(nodeStylesSource, /\.conditional-if-port-label \{[\s\S]*?left: -32px;/);
  assert.match(nodeStylesSource, /\.conditional-if-port-label \{[\s\S]*?padding: 0 3px;/);
  assert.match(nodeStylesSource, /\.conditional-if-port-label\.connected \{[\s\S]*?background:/);
  assert.ok(connectedLabelStyleBlock, 'expected connected conditional label style block');
  assert.doesNotMatch(connectedLabelStyleBlock, /left:/);
  assert.doesNotMatch(connectedLabelStyleBlock, /padding:/);
});

test('port labels expose reorder drag only in explicit rearrange modes', () => {
  const portSource = readFileSync(join(componentsDir, 'Port.tsx'), 'utf8');
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');
  const nodePortsSource = readFileSync(join(componentsDir, 'NodePorts.tsx'), 'utf8');
  const portReorderInteractionSource = readFileSync(
    join(componentsDir, 'nodeCanvas', 'portReorderInteraction.ts'),
    'utf8',
  );
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const colorsSource = readFileSync(join(componentsDir, '..', 'colors.css'), 'utf8');
  const appSrcDir = dirname(componentsDir);
  const contextMenuConfigurationSource = readFileSync(
    join(appSrcDir, 'hooks', 'useContextMenuConfiguration.ts'),
    'utf8',
  );
  const contextMenuHandlerSource = readFileSync(join(appSrcDir, 'hooks', 'useGraphBuilderContextMenuHandler.ts'), 'utf8');

  assert.match(portSource, /className=\{clsx\('port-label'/);
  assert.doesNotMatch(portSource, /draggable=\{reorderable\}/);
  assert.doesNotMatch(portSource, /onDragStart=/);
  assert.match(portSource, /onReorderMouseDown\?\.\(event, id, input, title\)/);
  assert.match(portSource, /data-reorder-nodeid=\{reorderable \? nodeId : undefined\}/);
  assert.match(portSource, /className=\{clsx\('port-circle'/);
  assert.match(
    portSource,
    /onMouseDown=\{\(e\) => \{[\s\S]*!isPrimaryPortMouseButton\(e\.button\)[\s\S]*return onMouseDown\?\.\(e, id, input\);/,
  );
  assert.match(
    portSource,
    /onMouseUp=\{\(e\) => \{[\s\S]*!isPrimaryPortMouseButton\(e\.button\)[\s\S]*onMouseUp\?\.\(e, id\);/,
  );
  assert.match(nodePortsSource, /const isSubGraphNode = node\.type === 'subGraph';/);
  assert.match(nodePortsSource, /subGraphPortRearrangeTargetState/);
  assert.match(nodePortsSource, /variadicPortRearrangeTargetState/);
  assert.match(nodePortsSource, /const isRearrangingSubGraphPorts =/);
  assert.match(nodePortsSource, /const isRearrangingVariadicPorts =/);
  assert.match(nodePortsSource, /getReorderableVariadicInputDefinitions/);
  assert.match(nodePortsSource, /getReorderableVariadicOutputDefinitions/);
  assert.match(nodePortsSource, /useReorderVariadicPortsCommand\(\)/);
  assert.match(nodePortsSource, /reorderVariadicPorts\(\{/);
  assert.match(nodePortsSource, /variadicPortReorderSpec\?\.kind === 'input-output-pair'/);
  assert.match(
    nodePortsSource,
    /className=\{`node-ports\$\{alignRegexMatchOutputsWithValues \? ' match-per-output-values' : ''\}\$\{/,
  );
  assert.match(nodePortsSource, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/);
  assert.match(nodePortsSource, /setSubGraphPortRearrangeTarget\(undefined\)/);
  assert.match(nodePortsSource, /setVariadicPortRearrangeTarget\(undefined\)/);
  assert.match(nodePortsSource, /subGraphPortRearrangeTarget\?\.projectId === projectId/);
  assert.match(nodePortsSource, /variadicPortRearrangeTarget\?\.projectId === projectId/);
  assert.match(nodePortsSource, /from '\.\/nodeCanvas\/portReorderInteraction\.js';/);
  assert.match(nodeCanvasSource, /subGraphPortRearrangeTargetState/);
  assert.match(nodeCanvasSource, /variadicPortRearrangeTargetState/);
  assert.match(nodeCanvasSource, /function shouldClearNodeScopedUiTarget/);
  assert.match(nodeCanvasSource, /options\.target\.projectId !== options\.currentProjectId/);
  assert.match(nodeCanvasSource, /options\.target\.graphId !== options\.currentGraphId/);
  assert.match(nodeCanvasSource, /!options\.nodes\.some\(\(node\) => node\.id === options\.target!\.nodeId\)/);
  assert.match(nodeCanvasSource, /target: subGraphPortRearrangeTarget/);
  assert.match(nodeCanvasSource, /target: variadicPortRearrangeTarget/);
  assert.match(nodePortsSource, /getPortOrderFromPoint/);
  assert.match(portReorderInteractionSource, /document\.querySelectorAll<HTMLElement>\('\[data-reorder-nodeid\]\[data-reorder-portid\]'\)/);
  assert.match(portReorderInteractionSource, /moveSubGraphPortIdToIndexInOrder/);
  assert.match(portReorderInteractionSource, /getPortOrderFromElementSnapshots/);
  assert.match(portReorderInteractionSource, /applyOrderedDefinitionSubset/);
  assert.match(nodePortsSource, /window\.addEventListener\('mousemove'/);
  assert.match(nodePortsSource, /window\.addEventListener\('mouseup'/);
  assert.match(nodePortsSource, /createPortal\(/);
  assert.match(nodePortsSource, /document\.body/);
  assert.match(nodePortsSource, /position: 'fixed'/);
  assert.match(nodePortsSource, /const labelRect = event\.currentTarget\.getBoundingClientRect\(\);/);
  assert.match(nodePortsSource, /pointerOffsetX: event\.clientX - labelRect\.left/);
  assert.match(nodePortsSource, /pointerOffsetY: event\.clientY - labelRect\.top/);
  assert.match(nodePortsSource, /left: draggedPort\.clientX - draggedPort\.pointerOffsetX/);
  assert.match(nodePortsSource, /top: draggedPort\.clientY - draggedPort\.pointerOffsetY/);
  assert.match(nodePortsSource, /width: draggedPort\.width/);
  assert.match(nodePortsSource, /isSubGraphErrorOutputDefinition/);
  assert.match(nodePortsSource, /outputDefinitions\.filter\(\(output\) => !isSubGraphErrorOutputDefinition\(node, output\)\)/);
  assert.match(nodePortsSource, /useEditNodeCommand\(\)/);
  assert.match(nodePortsSource, /mergeWithPrevious: false/);
  assert.match(contextMenuConfigurationSource, /id: 'node-rearrange-subgraph-ports'[\s\S]*label: 'Rearrange inputs\/outputs'/);
  assert.match(contextMenuConfigurationSource, /conditional: canRearrangeSubgraphPorts/);
  assert.match(contextMenuConfigurationSource, /id: 'node-rearrange-variadic-inputs'[\s\S]*label: 'Rearrange inputs'/);
  assert.match(
    contextMenuConfigurationSource,
    /id: 'node-rearrange-variadic-inputs-outputs'[\s\S]*label: 'Rearrange inputs\/outputs'/,
  );
  assert.match(contextMenuHandlerSource, /\.with\('node-rearrange-subgraph-ports'/);
  assert.match(contextMenuHandlerSource, /node-rearrange-variadic-inputs/);
  assert.match(contextMenuHandlerSource, /setVariadicPortRearrangeTarget\(undefined\);/);
  assert.match(contextMenuHandlerSource, /setSubGraphPortRearrangeTarget\(undefined\);/);
  assert.match(contextMenuHandlerSource, /setSubGraphPortRearrangeTarget\(\{ graphId, nodeId, projectId: project\.metadata\.id \}\)/);
  assert.match(contextMenuHandlerSource, /setVariadicPortRearrangeTarget\(\{ graphId, nodeId, projectId: project\.metadata\.id \}\)/);
  assert.doesNotMatch(nodeStylesSource, /\.node-ports\.subgraph-port-rearrange-mode[\s\S]*outline:/);
  assert.match(nodeStylesSource, /\.port\.reorderable \.port-label \{/);
  assert.match(nodeStylesSource, /background: var\(--node-port-reorder-label-bg\);/);
  assert.match(
    colorsSource,
    /--node-port-reorder-label-bg: color-mix\(in srgb, var\(--primary\) 18%, var\(--grey-darkest\) 82%\);/,
  );
  assert.match(nodeStylesSource, /border-radius: calc\(6px \* var\(--ui-font-scale\)\);/);
  assert.match(nodeStylesSource, /\.port\.reorder-dragging-source \.port-label \{[\s\S]*?visibility: hidden;/);
  assert.match(nodeStylesSource, /body\.port-reorder-dragging/);
});
