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
  assert.match(fullscreenOutput, /findFullscreenOutputScrollContainer/);
  assert.doesNotMatch(fullscreenOutput, /function findScrollContainer/);
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
