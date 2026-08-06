import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

function readComponent(...parts: string[]): string {
  return readFileSync(join(componentsDir, ...parts), 'utf8');
}

test('fullscreen object output uses foldable searchable JSON with stable display metrics', () => {
  const scalarRenderers = readComponent('renderDataValue', 'createScalarRenderers.tsx');
  const foldingCodeBlock = readComponent('renderDataValue', 'FoldingCodeBlock.tsx');
  const fullscreenOutput = readComponent('nodeOutput', 'NodeFullscreenOutput.tsx');
  const fullscreenModal = readComponent('FullScreenModal.tsx');
  const renderedDataOutputs = readComponent('nodeOutput', 'RenderDataOutputs.tsx');

  assert.match(scalarRenderers, /<FoldingCodeBlock text=\{stringified\} language="json"/);
  assert.match(foldingCodeBlock, /useFullscreenOutputSearchContext/);
  assert.match(foldingCodeBlock, /registerProvider/);
  assert.match(foldingCodeBlock, /const OUTPUT_CODE_LINE_HEIGHT = 20;/);
  assert.match(foldingCodeBlock, /lineHeight: OUTPUT_CODE_LINE_HEIGHT/);
  assert.match(foldingCodeBlock, /wordWrap=\{wrapLines \? 'on' : 'off'\}/);
  assert.match(foldingCodeBlock, /fontSizeScope="fullscreen-output"/);
  assert.match(foldingCodeBlock, /vertical: 'hidden'/);
  assert.match(foldingCodeBlock, /ScrollType\.Immediate/);
  assert.match(foldingCodeBlock, /scheduleFullscreenOutputSearchTargetReveal/);
  assert.doesNotMatch(fullscreenOutput, /findFullscreenOutputScrollContainer/);
  assert.match(fullscreenOutput, /position: sticky;/);
  assert.match(fullscreenOutput, /top: var\(--fullscreen-modal-vertical-inset\);/);
  assert.match(fullscreenOutput, /padding-bottom: calc\(24px \* var\(--ui-font-scale\)\);/);
  assert.match(fullscreenModal, /--fullscreen-modal-vertical-inset: 16px;/);
  assert.match(fullscreenModal, /border-top: 0 !important;/);
  assert.match(fullscreenModal, /border-bottom: 0 !important;/);
  assert.match(fullscreenModal, /padding-top: 0 !important;/);
  assert.match(fullscreenModal, /padding-bottom: 0 !important;/);
  assert.match(fullscreenOutput, /autoCollapseLlmChatDiagnosticOutputs: node\.type === 'llmChatV2'/);
  assert.match(renderedDataOutputs, /LLM_CHAT_LARGE_DIAGNOSTIC_OUTPUT_PORT_IDS/);
  assert.match(renderedDataOutputs, /LLM_CHAT_LARGE_DIAGNOSTIC_AUTO_COLLAPSE_CHARS = 1_000/);
  assert.match(renderedDataOutputs, /LLM_CHAT_MESSAGE_OUTPUT_PORT_IDS/);
  assert.match(renderedDataOutputs, /getOutputSectionArrayItemCount/);
  assert.doesNotMatch(renderedDataOutputs, /'requestBody'|\bresponseBody\b/);
  assert.match(renderedDataOutputs, /<CollapsiblePanel/);
  assert.match(renderedDataOutputs, /label=\{`\$\{label\} \(\$\{collapsedDescription\}\)`\}/);
  assert.match(renderedDataOutputs, /messageCount === 1 \? 'message' : 'messages'/);
  assert.match(renderedDataOutputs, /autoCollapseLlmChatDiagnosticOutputs/);
  assert.match(renderedDataOutputs, /isEligibleLlmChatDiagnosticOutput/);
  assert.match(renderedDataOutputs, /useFullscreenOutputSearchContext/);
  assert.match(renderedDataOutputs, /searchQuery\.trim\(\)\.length > 0/);

  const collapsiblePanel = readComponent('CollapsiblePanel.tsx');
  const editorGroup = readComponent('editors', 'EditorGroup.tsx');
  const runActivityDrawer = readComponent('runActivity', 'RunActivityDrawer.tsx');
  assert.match(collapsiblePanel, /--collapsible-panel-radius/);
  assert.match(collapsiblePanel, /aria-expanded=\{isOpen \?\? false\}/);
  assert.match(collapsiblePanel, /transitionTime=\{150\}/);
  assert.match(editorGroup, /<CollapsiblePanel/);
  assert.doesNotMatch(editorGroup, /from 'react-collapsible'/);
  assert.match(runActivityDrawer, /<CollapsiblePanel/);
  assert.match(runActivityDrawer, /toggleClassName="run-activity-row-toggle"/);
  assert.match(runActivityDrawer, /--collapsible-panel-padding-x: 0px;/);
  assert.doesNotMatch(runActivityDrawer, /from 'majesticons\/line\/chevron-/);
});

test('large stored JSON previews preserve safe wrapping and external search ownership', () => {
  const source = readComponent('renderDataValue', 'LargeStoredValuePreview.tsx');
  const searchSource = readComponent('renderDataValue', 'useLargeStoredValueFullscreenSearch.ts');
  const wrapStyles =
    /\.fullscreen-output-body\.wrap-lines & \.json-preview-content pre \{(?<styles>[\s\S]*?)\n  \}/.exec(source)?.groups
      ?.styles;

  assert.ok(wrapStyles);
  assert.match(wrapStyles, /overflow-wrap: break-word;/);
  assert.doesNotMatch(wrapStyles, /overflow-wrap:\s*anywhere;/);
  assert.match(source, /highlightMode: usesFoldingJsonPreview \? 'external' : 'dom'/);
  assert.match(searchSource, /scheduleFullscreenOutputSearchTargetReveal/);
});

test('decoded JSON string preview has separated range, geometry, state, and view owners', () => {
  const foldingCodeBlock = readComponent('renderDataValue', 'FoldingCodeBlock.tsx');
  const controller = readComponent('renderDataValue', 'JsonStringPreviewAffordance.tsx');
  const views = readComponent('renderDataValue', 'jsonStringPreview', 'views.tsx');
  const styles = readComponent('renderDataValue', 'jsonStringPreview', 'styles.ts');
  const preferences = readFileSync(join(componentsDir, '..', 'state', 'editorPreferences.ts'), 'utf8');

  assert.match(foldingCodeBlock, /<JsonStringPreviewAffordance/);
  assert.match(foldingCodeBlock, /enabled=\{language === 'json'\}/);
  assert.doesNotMatch(foldingCodeBlock, /onEditString/);
  assert.match(controller, /reduceJsonStringPreviewInteraction/);
  assert.match(controller, /getJsonStringPreviewButtonPlacement/);
  assert.match(controller, /calculateJsonStringPreviewPopoverPosition/);
  assert.match(controller, /<JsonStringPreviewPopover/);
  assert.match(controller, /<EditJsonStringModal/);
  assert.match(views, /copyToClipboard\(range\.decodedValue\)/);
  assert.match(styles, /json-string-preview-popover/);
  assert.match(preferences, /jsonStringPreviewPopoverWidthState = atomWithStorage<number>/);
  assert.match(preferences, /jsonStringEditModalSizeState = atomWithStorage<JsonStringEditModalSize>/);
});

test('structured node output keeps parsed source after returned values', () => {
  const structuredOutput = readComponent('nodes', 'StructuredNodeOutput.tsx');
  const codeNew = readComponent('nodes', 'CodeNewNode.tsx');
  const expression = readComponent('nodes', 'ExpressionNode.tsx');

  assert.match(structuredOutput, /\{children\}\s*\{parsedSourceSection\}/);
  assert.match(structuredOutput, /<FoldingCodeBlock text=\{source\} language=\{language\}/);
  assert.match(codeNew, /parsedSourceLabel="Parsed code"/);
  assert.match(expression, /parsedSourceLanguage="javascript"/);
});

test('generic node errors preserve line breaks in inline and fullscreen output', () => {
  const inlineOutput = readComponent('nodeOutput', 'NodeInlineOutput.tsx');
  const fullscreenOutput = readComponent('nodeOutput', 'NodeFullscreenOutput.tsx');
  const nodeStyles = readComponent('nodeStyles.ts');

  assert.match(inlineOutput, /<div className="node-output-error-message">\{content\.error\}<\/div>/);
  assert.match(fullscreenOutput, /<div className="node-output-error-message">\{content\.error\}<\/div>/);
  assert.match(nodeStyles, /\.node-output-error-message \{[\s\S]*?white-space: pre-wrap;/);
  assert.match(fullscreenOutput, /\.node-output-error-message \{[\s\S]*?white-space: pre-wrap;/);
});
