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
  const scalarRenderersSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'createScalarRenderers.tsx'),
    'utf8',
  );
  const largeStoredValuePreviewSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'LargeStoredValuePreview.tsx'),
    'utf8',
  );
  const foldingCodeBlockSource = readFileSync(join(componentsDir, 'renderDataValue', 'FoldingCodeBlock.tsx'), 'utf8');
  const useFullscreenOutputSearchSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'useFullscreenOutputSearch.ts'),
    'utf8',
  );
  const largeStoredValueSearchSource = readFileSync(
    join(componentsDir, 'renderDataValue', 'useLargeStoredValueFullscreenSearch.ts'),
    'utf8',
  );
  const structuredNodeOutputSource = readFileSync(join(componentsDir, 'nodes', 'StructuredNodeOutput.tsx'), 'utf8');
  const codeNewNodeSource = readFileSync(join(componentsDir, 'nodes', 'CodeNewNode.tsx'), 'utf8');

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
  assert.match(foldingCodeBlockSource, /wordWrap=\{wrapLines \? 'on' : 'off'\}/);
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
    /useFolding=\{renderMode === 'expanded-preview' && allowLargeStoredValueActions === true\}/,
  );
  assert.match(
    structuredNodeOutputSource,
    /<FoldingCodeBlock text=\{source\} language=\{language\} wrapLines=\{wrapLines\} \/>/,
  );
  assert.match(
    structuredNodeOutputSource,
    /<ColorizedPreformattedText text=\{source\} language=\{language\} \/>/,
  );
  assert.match(codeNewNodeSource, /parsedSourceLabel="Parsed code"/);
  assert.match(codeNewNodeSource, /wrapLines=\{wrapLines\}/);
});
