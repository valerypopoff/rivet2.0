import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('fullscreen object output uses foldable JSON while chunked previews keep safe wrapping', () => {
  const nodeFullscreenOutputSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeFullscreenOutput.tsx'),
    'utf8',
  );
  const codeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const scalarRenderersSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'createScalarRenderers.tsx'),
    'utf8',
  );
  const largeStoredValuePreviewSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'LargeStoredValuePreview.tsx'),
    'utf8',
  );
  const foldingCodeBlockSource = readFileSync(join(componentsDir, 'renderDataValue', 'FoldingCodeBlock.tsx'), 'utf8');
  const jsonStringPreviewAffordanceSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'JsonStringPreviewAffordance.tsx'),
    'utf8',
  );
  const jsonStringPreviewRangesSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'jsonStringPreviewRanges.ts'),
    'utf8',
  );
  const useFullscreenOutputSearchSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'useFullscreenOutputSearch.ts'),
    'utf8',
  );
  const uiStateSource = readFileSync(join(componentsDir, '..', 'state', 'ui.ts'), 'utf8');
  const largeStoredValueSearchSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'useLargeStoredValueFullscreenSearch.ts'),
    'utf8',
  );
  const structuredNodeOutputSource = readFileSync(join(componentsDir, 'nodes', 'StructuredNodeOutput.tsx'), 'utf8');
  const codeNewNodeSource = readFileSync(join(componentsDir, 'nodes', 'CodeNewNode.tsx'), 'utf8');
  const expressionNodeSource = readFileSync(join(componentsDir, 'nodes', 'ExpressionNode.tsx'), 'utf8');
  const jsListNodeSource = readFileSync(join(componentsDir, 'nodes', 'JSListNode.tsx'), 'utf8');
  const extractObjectPathNodeSource = readFileSync(join(componentsDir, 'nodes', 'ExtractObjectPathNode.tsx'), 'utf8');

  const largeStoredWrapBlock =
    /\.fullscreen-output-body\.wrap-lines & \.json-preview-content pre \{(?<styles>[\s\S]*?)\n  \}/.exec(
      largeStoredValuePreviewSource,
    )?.groups?.styles;

  assert.match(
    scalarRenderersSource,
    /<FoldingCodeBlock text=\{stringified\} language="json" wrapLines=\{wrapLines \?\? true\} \/>/,
  );
  assert.match(scalarRenderersSource, /<ColorizedPreformattedText text=\{stringified\} language="json" wrapWords \/>/);

  assert.match(largeStoredValuePreviewSource, /\.json-preview-content pre \{/);
  assert.ok(largeStoredWrapBlock, 'Expected dedicated fullscreen wrapping styles for large stored JSON previews');
  assert.match(largeStoredWrapBlock, /overflow-wrap: break-word;/);
  assert.match(largeStoredWrapBlock, /word-break: normal;/);
  assert.doesNotMatch(largeStoredWrapBlock, /overflow-wrap:\s*anywhere;/);
  assert.match(
    largeStoredValuePreviewSource,
    /<FoldingCodeBlock[\s\S]*text=\{activeChunkText \?\? ''\}[\s\S]*language="json"[\s\S]*wrapLines=\{wrapLines\}[\s\S]*searchProvider=\{false\}[\s\S]*activeMatchRange=\{activeMatchRange\}/,
  );
  assert.match(largeStoredValuePreviewSource, /const rawProviderInstanceId = useId\(\);/);
  assert.match(
    largeStoredValuePreviewSource,
    /const providerId = `large-stored-value-\$\{value\.refId\}-\$\{rawProviderInstanceId\}`;/,
  );
  assert.match(largeStoredValuePreviewSource, /highlightMode: usesFoldingJsonPreview \? 'external' : 'dom'/);
  assert.match(
    largeStoredValuePreviewSource,
    /<div className="json-preview-content">\s*<ColorizedPreformattedText text=\{activeChunkText \?\? ''\} language="json" wrapWords \/>/,
  );
  assert.match(nodeFullscreenOutputSource, /wrapLines,/);
  assert.match(foldingCodeBlockSource, /useFullscreenOutputSearchContext/);
  assert.match(foldingCodeBlockSource, /registerProvider/);
  assert.match(foldingCodeBlockSource, /findMatchRanges\(text, query\)/);
  assert.match(foldingCodeBlockSource, /editor\.revealRangeInCenterIfOutsideViewport\(range\)/);
  assert.match(foldingCodeBlockSource, /const OUTPUT_CODE_LINE_HEIGHT = 20;/);
  assert.match(foldingCodeBlockSource, /lineCount \* OUTPUT_CODE_LINE_HEIGHT/);
  assert.match(foldingCodeBlockSource, /wordWrap=\{wrapLines \? 'on' : 'off'\}/);
  assert.match(foldingCodeBlockSource, /const OUTPUT_CODE_EDITOR_DISPLAY_OPTIONS: CodeEditorDisplayOptions = \{/);
  assert.match(foldingCodeBlockSource, /fontFamily: 'var\(--font-family-monospace\)'/);
  assert.match(foldingCodeBlockSource, /lineHeight: OUTPUT_CODE_LINE_HEIGHT/);
  assert.match(foldingCodeBlockSource, /padding: \{ top: 0, bottom: 0 \}/);
  assert.match(foldingCodeBlockSource, /roundedSelection: false/);
  assert.match(foldingCodeBlockSource, /selectionHighlight: false/);
  assert.match(foldingCodeBlockSource, /occurrencesHighlight: false/);
  assert.match(foldingCodeBlockSource, /renderLineHighlight: 'none'/);
  assert.match(foldingCodeBlockSource, /displayOptions=\{OUTPUT_CODE_EDITOR_DISPLAY_OPTIONS\}/);
  assert.match(codeEditorSource, /export type CodeEditorDisplayOptions = Pick</);
  assert.match(codeEditorSource, /displayOptions\?: CodeEditorDisplayOptions;/);
  assert.match(codeEditorSource, /\.\.\.displayOptions,\s*fontSize,/);
  assert.match(foldingCodeBlockSource, /onContentHeightChange=\{handleContentHeightChange\}/);
  assert.match(foldingCodeBlockSource, /vertical: 'hidden'/);
  assert.match(foldingCodeBlockSource, /handleMouseWheel: false/);
  assert.doesNotMatch(foldingCodeBlockSource, /70vh/);
  assert.match(foldingCodeBlockSource, /background: transparent !important;/);
  assert.match(foldingCodeBlockSource, /MATCH_CLASS/);
  assert.match(foldingCodeBlockSource, /MATCH_ACTIVE_CLASS/);
  assert.match(foldingCodeBlockSource, /clearActiveMatch/);
  assert.match(foldingCodeBlockSource, /clearMatches/);
  assert.match(foldingCodeBlockSource, /querySelector<HTMLElement>\(`\.\$\{MATCH_ACTIVE_CLASS\}`\)/);
  assert.match(foldingCodeBlockSource, /JsonStringPreviewAffordance/);
  assert.match(foldingCodeBlockSource, /enabled=\{language === 'json'\}/);
  assert.match(jsonStringPreviewAffordanceSource, /const jsonStringPreviewAffordanceStyles = css/);
  assert.match(jsonStringPreviewAffordanceSource, /<Global styles=\{jsonStringPreviewAffordanceStyles\} \/>/);
  assert.match(jsonStringPreviewAffordanceSource, /max-width: calc\(100vw - 24px\)/);
  assert.doesNotMatch(foldingCodeBlockSource, /width: min\(420px/);
  assert.match(jsonStringPreviewAffordanceSource, /buttonCoordinateMode\?: 'root' \| 'viewport'/);
  assert.match(jsonStringPreviewAffordanceSource, /buttonCoordinateMode = 'viewport'/);
  assert.match(jsonStringPreviewAffordanceSource, /getJsonStringPreviewRanges\(text, \{ minDecodedLength \}\)/);
  assert.match(jsonStringPreviewAffordanceSource, /coordinateMode = buttonCoordinateMode/);
  assert.match(jsonStringPreviewAffordanceSource, /json-string-preview-button-local/);
  assert.doesNotMatch(jsonStringPreviewAffordanceSource, /buttonAnchor|visible-position|buttonPositionRef/);
  assert.match(jsonStringPreviewAffordanceSource, /findJsonStringPreviewRangeAtOffset/);
  assert.match(jsonStringPreviewAffordanceSource, /getScrolledVisiblePosition/);
  assert.match(jsonStringPreviewAffordanceSource, /type ButtonState = \{/);
  assert.match(jsonStringPreviewAffordanceSource, /position: fixed;/);
  assert.match(jsonStringPreviewAffordanceSource, /z-index: 4000;/);
  assert.match(jsonStringPreviewAffordanceSource, /style=\{\{ left: buttonState\.left, top: buttonState\.top \}\}/);
  assert.doesNotMatch(jsonStringPreviewAffordanceSource, /editor\.addContentWidget|IContentWidget/);
  assert.doesNotMatch(jsonStringPreviewAffordanceSource, /widgetId|data-widget-id/);
  assert.match(jsonStringPreviewAffordanceSource, /buttonRangeRef/);
  assert.match(jsonStringPreviewAffordanceSource, /getButtonStateForRange\(range\)/);
  assert.match(
    jsonStringPreviewAffordanceSource,
    /buttonStateRef\.current\?\.range \?\? activeRangeRef\.current \?\? buttonRangeRef\.current/,
  );
  assert.match(jsonStringPreviewAffordanceSource, /buttonRef\.current\?\.contains\(target\)/);
  assert.match(jsonStringPreviewAffordanceSource, /getTargetAtClientPoint\(clientX, clientY\)/);
  assert.match(jsonStringPreviewAffordanceSource, /editor\.onMouseDown/);
  assert.match(jsonStringPreviewAffordanceSource, /editor\.onDidFocusEditorText/);
  assert.match(jsonStringPreviewAffordanceSource, /onPointerDownCapture=\{\(event\) =>/);
  assert.match(jsonStringPreviewAffordanceSource, /onPointerDown=\{\(event\) =>/);
  assert.match(jsonStringPreviewAffordanceSource, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(jsonStringPreviewAffordanceSource, /copyToClipboard\(popover\.range\.decodedValue\)/);
  assert.match(jsonStringPreviewAffordanceSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(jsonStringPreviewAffordanceSource, /ownerDocument\.defaultView/);
  assert.match(
    jsonStringPreviewAffordanceSource,
    /popoverWindow\.addEventListener\('pointerdown', handlePointerDown, true\)/,
  );
  assert.match(jsonStringPreviewAffordanceSource, /useAtom\(jsonStringPreviewPopoverWidthState\)/);
  assert.match(jsonStringPreviewAffordanceSource, /clampJsonStringPreviewPopoverWidth/);
  assert.match(jsonStringPreviewAffordanceSource, /getVisibleJsonStringPreviewPopoverWidth/);
  assert.match(
    jsonStringPreviewAffordanceSource,
    /style=\{\{ left: popover\.left, top: popover\.top, width: visiblePopoverWidth \}\}/,
  );
  assert.match(jsonStringPreviewAffordanceSource, /createPortal\(popoverElement, popoverPortalElement\)/);
  assert.match(jsonStringPreviewAffordanceSource, /onPointerDown=\{handleResizePointerDown\}/);
  assert.match(jsonStringPreviewAffordanceSource, /aria-label="Resize preview width"/);
  assert.doesNotMatch(jsonStringPreviewAffordanceSource, /json-string-preview-close-button/);
  assert.doesNotMatch(jsonStringPreviewRangesSource, /JSON\.parse\(text\)/);
  assert.match(jsonStringPreviewRangesSource, /JSON\.parse\(rawLiteral\)/);
  assert.match(jsonStringPreviewRangesSource, /isObjectKeyLiteral/);
  assert.match(jsonStringPreviewRangesSource, /DEFAULT_JSON_STRING_PREVIEW_MIN_LENGTH = 120/);
  assert.match(uiStateSource, /jsonStringPreviewPopoverWidthState = atomWithStorage<number>/);
  assert.match(uiStateSource, /DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH = 420/);
  assert.match(useFullscreenOutputSearchSource, /function clearProviderMatches\(provider: SearchProvider\): void/);
  assert.match(useFullscreenOutputSearchSource, /provider\.clearMatches/);
  assert.match(
    largeStoredValueSearchSource,
    /clearActiveMatch: \(\) => \{\s*setActiveSearchMatch\(null\);\s*restoreAutoExpandedSearchState\(\);\s*\},/,
  );
  assert.match(
    largeStoredValueSearchSource,
    /clearMatches: \(\) => \{\s*currentSearchMatchRangesRef\.current = \[\];\s*setActiveSearchMatch\(null\);/,
  );
  assert.match(
    structuredNodeOutputSource,
    /const useFoldableParsedSource = renderMode === 'expanded-preview' && allowLargeStoredValueActions === true;/,
  );
  assert.doesNotMatch(structuredNodeOutputSource, /placeParsedSourceBeforeChildren/);
  assert.match(structuredNodeOutputSource, /\{children\}\s*\{parsedSourceSection\}/);
  assert.match(
    structuredNodeOutputSource,
    /<FoldingCodeBlock text=\{source\} language=\{language\} wrapLines=\{wrapLines\} \/>/,
  );
  assert.match(structuredNodeOutputSource, /<ColorizedPreformattedText text=\{source\} language=\{language\} \/>/);
  assert.match(codeNewNodeSource, /parsedSourceLabel="Parsed code"/);
  assert.match(codeNewNodeSource, /wrapLines=\{wrapLines\}/);
  assert.match(expressionNodeSource, /parsedSourceLanguage="javascript"/);
  assert.match(jsListNodeSource, /parsedSourceLanguage="javascript"/);
  assert.match(extractObjectPathNodeSource, /parsedSourceLanguage="jsonpath"/);
});
