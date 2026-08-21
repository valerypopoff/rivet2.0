import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('drag previews use the same output preview sizing as hovered nodes', () => {
  const visualNodeSource = readFileSync(join(componentsDir, 'VisualNode.tsx'), 'utf8');
  const nodeCanvasViewportSource = readFileSync(join(componentsDir, 'nodeCanvas', 'NodeCanvasViewport.tsx'), 'utf8');
  const normalVisualNodeContentSource = readFileSync(
    join(componentsDir, 'visualNode', 'NormalVisualNodeContent.tsx'),
    'utf8',
  );
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');

  assert.match(visualNodeSource, /const isOutputPreviewHovered = Boolean\(isHovered \|\| shouldShowHoverControls\);/);
  assert.match(
    normalVisualNodeContentSource,
    /<NodeOutput[\s\S]*?node=\{node\}[\s\S]*?suspended=\{!renderHeavyContent\}[\s\S]*?isHovered=\{isOutputPreviewHovered\}[\s\S]*?\/>/,
  );
  assert.match(
    nodeCanvasViewportSource,
    /key=\{`comment-drag-preview-\$\{node\.id\}`\}[\s\S]*?shouldShowHoverControls=\{draggingHoverControlSourceNodeIdSet\.has\(executionSourceNodeId\)\}/,
  );
  assert.match(
    nodeCanvasViewportSource,
    /<DragOverlay[\s\S]*?executionSourceNodeId[\s\S]*?shouldShowHoverControls=\{draggingHoverControlSourceNodeIdSet\.has\(executionSourceNodeId\)\}/,
  );
  assert.match(nodeInlineOutputSource, /resolveNodeOutputPreviewMode\(\{\s*isOutputExpanded,\s*isHovered,/);
  assert.match(nodeStylesSource, /\.node:is\(:hover, \.hovered, \.showHoverControls\) \.node-output-inner,/);
  assert.match(nodeStylesSource, /\.node:is\(:hover, \.hovered, \.showHoverControls\) \.multi-node-output/);
});

test('node drags clear stale canvas hover state', () => {
  const nodeCanvasSource = readFileSync(join(componentsDir, 'NodeCanvas.tsx'), 'utf8');

  assert.match(
    nodeCanvasSource,
    /const clearHoveringNode = useStableCallback\(\(\) => \{\s*setHoveringNode\(undefined\);/,
  );
  assert.match(
    nodeCanvasSource,
    /const syncHoveringNodeFromPointer = useStableCallback\(\(\) => \{[\s\S]*?document\.elementFromPoint\(lastMouseInfoRef\.current\.x, lastMouseInfoRef\.current\.y\);[\s\S]*?\.node\[data-nodeid\]:not\(\.overlayNode\)/,
  );
  assert.match(nodeCanvasSource, /const hoverSyncAnimationFrameRef = useRef<number \| undefined>\(\);/);
  assert.match(nodeCanvasSource, /window\.cancelAnimationFrame\(hoverSyncAnimationFrameRef\.current\);/);
  assert.match(
    nodeCanvasSource,
    /const preserveMoveDragHoverOnDrop = useStableCallback\(\(nodeId: NodeId\) => \{[\s\S]*?if \(dragMode === 'move'\) \{[\s\S]*?setHoveringNode\(nodeId\);/,
  );
  assert.match(
    nodeCanvasSource,
    /onDragStart=\{\(event\) => \{[\s\S]*?onNodeStartDrag\(event\);[\s\S]*?clearHoveringNode\(\);/,
  );
  assert.match(
    nodeCanvasSource,
    /onDragEnd=\{\(event\) => \{[\s\S]*?clearNodeDragGesture\(\);[\s\S]*?preserveMoveDragHoverOnDrop\(event\.active\.id as NodeId\);[\s\S]*?try \{[\s\S]*?onNodeDragged\(event\);[\s\S]*?\} finally \{[\s\S]*?syncHoveringNodeFromPointer\(\);/,
  );
  assert.match(
    nodeCanvasSource,
    /onDragCancel=\{\(\) => \{[\s\S]*?clearNodeDragGesture\(\);[\s\S]*?try \{[\s\S]*?onNodeDragCancelled\(\);[\s\S]*?\} finally \{[\s\S]*?syncHoveringNodeFromPointer\(\);/,
  );
});

test('node output content fade only replays for unseen output content', () => {
  const nodeOutputContentStateSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeOutputContentState.tsx'),
    'utf8',
  );
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');

  assert.match(nodeOutputContentStateSource, /const seenNodeOutputContentKeys = new Set<string>\(\);/);
  assert.match(
    nodeOutputContentStateSource,
    /const shouldAnimateRef = useRef\(!seenNodeOutputContentKeys\.has\(contentKey\)\);/,
  );
  assert.match(nodeOutputContentStateSource, /rememberNodeOutputContentKey\(contentKey\);/);
  assert.match(nodeInlineOutputSource, /<NodeOutputContentFade key=\{contentKey\} contentKey=\{contentKey\}>/);
  assert.match(
    nodeOutputContentStateSource,
    /&\.animate-node-output-content \{\s*animation: node-output-content-fade-in 140ms ease-out both;/,
  );
});

test('node output rendering does not fall back to stale all-run data after graph-run filtering', () => {
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const nodeFullscreenOutputSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeFullscreenOutput.tsx'),
    'utf8',
  );
  const portInfoSource = readFileSync(join(componentsDir, 'PortInfo.tsx'), 'utf8');

  assert.match(
    nodeInlineOutputSource,
    /filterProcessDataForSelection\(\{ \.\.\.graphSelectionOptions, processData: output \}\)/,
  );
  assert.match(
    nodeFullscreenOutputSource,
    /filterProcessDataForSelection\(\{ \.\.\.graphSelectionOptions, processData: output \}\)/,
  );
  assert.doesNotMatch(nodeInlineOutputSource, /filterProcessDataForSelection\([\s\S]*?\)\s*\?\?\s*output/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /filterProcessDataForSelection\([\s\S]*?\)\s*\?\?\s*output/);
  assert.match(
    portInfoSource,
    /filterProcessDataForSelection\(\{ \.\.\.graphSelectionOptions, processData: lastRun \}\)/,
  );
});

test('inline node output replacement grace is scoped to the selected graph run', () => {
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const nodeOutputContentStateSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeOutputContentState.tsx'),
    'utf8',
  );

  assert.match(nodeInlineOutputSource, /const selectedGraphRunScopeKey = getSelectedGraphRunId\(/);
  assert.match(nodeInlineOutputSource, /replacementScopeKey: selectedGraphRunScopeKey,/);
  assert.match(
    nodeOutputContentStateSource,
    /displayState\.replacementScopeKey === replacementScopeKey \? displayState\.output : undefined/,
  );
});

test('node output pagers clamp stale process page selections to the filtered process list', () => {
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const nodeFullscreenOutputSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeFullscreenOutput.tsx'),
    'utf8',
  );
  const portInfoSource = readFileSync(join(componentsDir, 'PortInfo.tsx'), 'utf8');

  assert.match(nodeInlineOutputSource, /const selectedPageIndex = getSelectedProcessPageIndex\(data, selectedPage\);/);
  assert.match(
    nodeFullscreenOutputSource,
    /const selectedPageIndex = getSelectedProcessPageIndex\(filteredOutput, selectedPage\);/,
  );
  assert.match(
    portInfoSource,
    /const selectedPageIndex = getSelectedProcessPageIndex\(filteredLastRun, selectedPage\);/,
  );
});

test('inline node output actions reserve flow space without moving their hit targets', () => {
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const renderDataOutputsSource = readFileSync(join(componentsDir, 'nodeOutput', 'RenderDataOutputs.tsx'), 'utf8');
  const renderDataValueStylesSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'renderDataValueStyles.ts'),
    'utf8',
  );
  const outputSectionHeaderSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'OutputSectionHeader.tsx'),
    'utf8',
  );
  const structuredNodeOutputSource = readFileSync(join(componentsDir, 'nodes', 'StructuredNodeOutput.tsx'), 'utf8');
  const largeStoredValuePreviewSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'LargeStoredValuePreview.tsx'),
    'utf8',
  );
  const renderedDataOutputsStylesBlock = /export const renderedDataOutputsStyles = css`(?<styles>[\s\S]*?)`;/u.exec(
    renderDataValueStylesSource,
  )?.groups?.styles;
  const structuredNodeOutputStylesBlock = /const structuredNodeOutputCss = css`(?<styles>[\s\S]*?)`;/u.exec(
    structuredNodeOutputSource,
  )?.groups?.styles;

  assert.ok(renderedDataOutputsStylesBlock);
  assert.ok(structuredNodeOutputStylesBlock);
  assert.match(
    largeStoredValuePreviewSource,
    /const styles = css`\s*display: block;[\s\S]*?> \* \+ \* \{[\s\S]*?margin-top: 8px;/,
  );

  assert.match(
    nodeInlineOutputSource,
    /const hasPromptDesignerAction = node\.type === 'llmChatV2' && \(node as LLMChatV2Node\)\.data\.configurationMode !== 'profile';/,
  );
  assert.match(nodeInlineOutputSource, /const hasResponseInspectorAction = node\.type === 'llmChatV2';/);
  assert.match(nodeInlineOutputSource, /<AgentResponseInspector[\s\S]*?renderInPortal \/>/);
  assert.match(nodeInlineOutputSource, /'node-output-inner has-output-actions has-extra-output-action'/);
  assert.match(nodeInlineOutputSource, /'node-output-inner has-output-actions'/);
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-actions-top: [^;]+;[\s\S]*?--node-output-actions-right: [^;]+;[\s\S]*?--node-output-actions-gap: [^;]+;/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-action-hit-size: [^;]+;[\s\S]*?--node-output-surface-padding: [^;]+;[\s\S]*?--node-output-action-exclusion-width: [^;]+;/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-action-exclusion-height: var\(--node-output-action-hit-size\);[\s\S]*?--node-output-action-exclusion-top: calc\(var\(--node-output-actions-top\) - var\(--node-output-surface-padding\)\);[\s\S]*?--node-output-action-exclusion-right: var\(--node-output-actions-right\);[\s\S]*?--node-output-action-exclusion-left-gap: [^;]+;/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-action-icon-offset-x: [^;]+;[\s\S]*?--node-output-action-icon-offset-y: [^;]+;/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-unfold-icon-size: [^;]+;[\s\S]*?--node-output-unfold-icon-offset-x: [^;]+;[\s\S]*?--node-output-unfold-icon-offset-y: [^;]+;/,
  );
  assert.match(nodeStylesSource, /--node-output-unfold-margin-left: 0px;/);
  assert.match(nodeStylesSource, /--node-output-unfold-margin-right: 0px;/);
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-copy-icon-size: [^;]+;[\s\S]*?--node-output-copy-icon-offset-x: [^;]+;[\s\S]*?--node-output-copy-icon-offset-y: [^;]+;/,
  );
  assert.match(nodeStylesSource, /--node-output-copy-margin-left: 0px;/);
  assert.match(nodeStylesSource, /--node-output-copy-margin-right: 0px;/);
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-response-inspector-icon-size: [^;]+;[\s\S]*?--node-output-response-inspector-icon-offset-x: [^;]+;[\s\S]*?--node-output-response-inspector-icon-offset-y: [^;]+;/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-response-inspector-margin-left: calc\(3\.5px \* var\(--ui-font-scale\)\);[\s\S]*?--node-output-response-inspector-margin-right: calc\(-2px \* var\(--ui-font-scale\)\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-prompt-designer-icon-size: [^;]+;[\s\S]*?--node-output-prompt-designer-icon-offset-x: [^;]+;[\s\S]*?--node-output-prompt-designer-icon-offset-y: [^;]+;/,
  );
  assert.match(nodeStylesSource, /--node-output-prompt-designer-margin-left: 0px;/);
  assert.match(nodeStylesSource, /--node-output-prompt-designer-margin-right: 0px;/);
  assert.match(
    nodeStylesSource,
    /\.node-output-inner,[\s\S]*?--node-output-fullscreen-icon-size: [^;]+;[\s\S]*?--node-output-fullscreen-icon-offset-x: [^;]+;[\s\S]*?--node-output-fullscreen-icon-offset-y: [^;]+;/,
  );
  assert.match(nodeStylesSource, /--node-output-fullscreen-margin-left: 0px;/);
  assert.match(nodeStylesSource, /--node-output-fullscreen-margin-right: 0px;/);
  assert.match(
    nodeStylesSource,
    /\.node-output-inner\.has-extra-output-action \{[\s\S]*?--node-output-action-exclusion-width: calc\(120px \* var\(--ui-font-scale\)\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.node-output-inner\.has-output-actions \.node-output-content-fade::before \{[\s\S]*?float: right;[\s\S]*?width: var\(--node-output-action-exclusion-width\);[\s\S]*?height: var\(--node-output-action-exclusion-height\);[\s\S]*?margin-top: var\(--node-output-action-exclusion-top\);[\s\S]*?margin-right: var\(--node-output-action-exclusion-right\);[\s\S]*?margin-left: var\(--node-output-action-exclusion-left-gap\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.overlay-buttons \{[\s\S]*?position: absolute;[\s\S]*?top: var\(--node-output-actions-top\);[\s\S]*?right: var\(--node-output-actions-right\);[\s\S]*?gap: var\(--node-output-actions-gap\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.copy-button,[\s\S]*?\.response-inspector-button,[\s\S]*?\.prompt-designer-button \{[\s\S]*?width: var\(--node-output-action-hit-size\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.output-toggle-button \{[\s\S]*?margin-left: var\(--node-output-unfold-margin-left\);[\s\S]*?margin-right: var\(--node-output-unfold-margin-right\);[\s\S]*?\.copy-button \{[\s\S]*?margin-left: var\(--node-output-copy-margin-left\);[\s\S]*?margin-right: var\(--node-output-copy-margin-right\);[\s\S]*?\.response-inspector-button \{[\s\S]*?margin-left: var\(--node-output-response-inspector-margin-left\);[\s\S]*?margin-right: var\(--node-output-response-inspector-margin-right\);[\s\S]*?\.prompt-designer-button \{[\s\S]*?margin-left: var\(--node-output-prompt-designer-margin-left\);[\s\S]*?margin-right: var\(--node-output-prompt-designer-margin-right\);[\s\S]*?\.expand-button \{[\s\S]*?margin-left: var\(--node-output-fullscreen-margin-left\);[\s\S]*?margin-right: var\(--node-output-fullscreen-margin-right\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.output-toggle-button svg \{[\s\S]*?width: var\(--node-output-unfold-icon-size\);[\s\S]*?height: var\(--node-output-unfold-icon-size\);[\s\S]*?transform: translate\(var\(--node-output-unfold-icon-offset-x\), var\(--node-output-unfold-icon-offset-y\)\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.copy-button svg \{[\s\S]*?width: var\(--node-output-copy-icon-size\);[\s\S]*?height: var\(--node-output-copy-icon-size\);[\s\S]*?transform: translate\(var\(--node-output-copy-icon-offset-x\), var\(--node-output-copy-icon-offset-y\)\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.response-inspector-button svg \{[\s\S]*?width: var\(--node-output-response-inspector-icon-size\);[\s\S]*?height: var\(--node-output-response-inspector-icon-size\);[\s\S]*?transform: translate\(\s*var\(--node-output-response-inspector-icon-offset-x\),\s*var\(--node-output-response-inspector-icon-offset-y\)\s*\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.prompt-designer-button svg \{[\s\S]*?width: var\(--node-output-prompt-designer-icon-size\);[\s\S]*?height: var\(--node-output-prompt-designer-icon-size\);[\s\S]*?transform: translate\(\s*var\(--node-output-prompt-designer-icon-offset-x\),\s*var\(--node-output-prompt-designer-icon-offset-y\)\s*\);/,
  );
  assert.match(
    nodeStylesSource,
    /\.expand-button svg \{[\s\S]*?width: var\(--node-output-fullscreen-icon-size\);[\s\S]*?height: var\(--node-output-fullscreen-icon-size\);[\s\S]*?transform: translate\(var\(--node-output-fullscreen-icon-offset-x\), var\(--node-output-fullscreen-icon-offset-y\)\);/,
  );
  assert.match(renderedDataOutputsStylesBlock.trimStart(), /^display: block;/);
  assert.match(
    renderDataValueStylesSource,
    /export const outputSectionGroupGap = 'calc\(18px \* var\(--ui-font-scale\)\)';/,
  );
  assert.match(
    renderDataValueStylesSource,
    /export const outputSectionFullscreenGroupGap = 'calc\(28px \* var\(--ui-font-scale\)\)';/,
  );
  assert.match(
    renderedDataOutputsStylesBlock,
    /&\.large-output-sections \{[\s\S]*?--output-section-group-gap: \$\{outputSectionFullscreenGroupGap\};/,
  );
  assert.match(
    renderedDataOutputsStylesBlock,
    /\.port-value \+ \.port-value \{[\s\S]*?margin-top: var\(--output-section-group-gap, \$\{outputSectionGroupGap\}\);/,
  );
  assert.match(
    renderDataValueStylesSource,
    /export const outputSectionLabelStyles = css`[\s\S]*?font-size: var\(--ui-font-size-sm\);/,
  );
  assert.match(
    renderDataValueStylesSource,
    /export const outputSectionFullscreenLabelStyles = css`[\s\S]*?font-size: var\(--ui-font-size-lg\);/,
  );
  assert.match(renderDataValueStylesSource, /outputSectionHeaderMetaStyles/);
  assert.match(
    renderDataOutputsSource,
    /createNodeOutputSectionsViewModel\(\{[\s\S]*?showLargeHeaders: showSectionStats,/,
  );
  assert.match(renderDataOutputsSource, /serializeDisplayedPortValue\(outputs, section\.portId, dataRefs\)/);
  assert.match(
    structuredNodeOutputSource,
    /const getCopyValue =[\s\S]*?statsText \?\? serializeDisplayedDataValue\(statsValue, dataRefs\)/,
  );
  assert.match(outputSectionHeaderSource, /content="Copy value"/);
  assert.match(outputSectionHeaderSource, /className="output-section-copy-button"/);
  assert.match(
    renderDataValueStylesSource,
    /export const outputSectionCopyButtonStyles = css`[\s\S]*?transform: translateY\(calc\(4px \* var\(--ui-font-scale\)\)\);/,
  );
  assert.match(renderDataOutputsSource, /<OutputSectionHeader[\s\S]*?isLarge=\{section\.headerMode === 'large'\}/);
  assert.match(renderedDataOutputsStylesBlock, /\.output-section-header \{[\s\S]*?align-items: baseline;/);
  assert.match(structuredNodeOutputStylesBlock.trimStart(), /^display: block;/);
  assert.match(
    structuredNodeOutputStylesBlock,
    /&\.large-output-sections \{[\s\S]*?--output-section-group-gap: \$\{outputSectionFullscreenGroupGap\};/,
  );
  assert.match(
    structuredNodeOutputStylesBlock,
    /\.structured-node-output-section \+ \.structured-node-output-section \{[\s\S]*?margin-top: var\(--output-section-group-gap, \$\{outputSectionGroupGap\}\);/,
  );
  assert.match(structuredNodeOutputStylesBlock, /\.output-section-header \{[\s\S]*?align-items: baseline;/);
});

test('response inspector uses semantic diagnostics in an app-level modal', () => {
  const inspectorSource = readFileSync(join(componentsDir, 'agentTrace', 'AgentResponseInspector.tsx'), 'utf8');

  assert.match(inspectorSource, /<MetricGroup title="Execution">/);
  assert.match(inspectorSource, /title="Recovery behavior"/);
  assert.match(inspectorSource, /label="Provider request retries"/);
  assert.match(inspectorSource, /label="LLM profile fallbacks"/);
  assert.match(inspectorSource, /<MetricGroup title="Usage and cost">/);
  assert.match(inspectorSource, /<h3>Timing<\/h3>/);
  assert.match(inspectorSource, /<ModalTransition>/);
  assert.match(inspectorSource, /<Modal onClose=\{onClose\} width="large">/);
  assert.match(inspectorSource, /<AppModalHeader title="Response inspector" onClose=\{onClose\} \/>/);
  assert.match(inspectorSource, /<ModalBody>\{content\}<\/ModalBody>/);
  assert.doesNotMatch(inspectorSource, /createPortal/);
  assert.match(inspectorSource, /const useEditorModal = renderInPortal && typeof document !== 'undefined'/);
  assert.match(inspectorSource, /\.rivet-agent-response-inspector-metrics \{[\s\S]*?margin: 0;[\s\S]*?padding: 0;/);
  assert.match(
    inspectorSource,
    /header button:focus-visible \{[\s\S]*?box-shadow: inset 0 0 0 1px var\(--rivet-web-app-control-focus-border, var\(--primary\)\);/,
  );
  assert.match(inspectorSource, /--response-inspector-card-background: var\(--surface-row-hover-bg\)/);
  assert.match(inspectorSource, /--response-inspector-muted: var\(--foreground-muted\)/);
  assert.match(inspectorSource, /const inlineResponseInspectorCss = css/);
  assert.doesNotMatch(inspectorSource, /Open graph at this run/);
  assert.doesNotMatch(inspectorSource, /trace\.(?:traceId|graphId|nodeId|processId)/);
});
