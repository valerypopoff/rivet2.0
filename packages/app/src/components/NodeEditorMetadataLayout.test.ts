import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('node metadata title and description share the same text inset', () => {
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');

  assert.match(nodeEditorSource, /--node-metadata-text-inset: 12px;/);
  assert.match(nodeEditorSource, /--node-metadata-control-border-width: 1px;/);
  assert.match(
    nodeEditorSource,
    /\.node-title-field \.node-title-read-button \.title-read-content {\s+width: 100%;[\s\S]*?padding: 0 var\(--node-metadata-text-inset\);/,
  );
  assert.match(
    nodeEditorSource,
    /\.node-title-field input {\s+height: 40px;[\s\S]*?padding: 0 calc\(var\(--node-metadata-text-inset\) - var\(--node-metadata-control-border-width\)\);/,
  );
  assert.match(
    nodeEditorSource,
    /\.node-description-field \[data-read-view-fit-container-width='true'\] {\s+display: block;[\s\S]*?border: 0 !important;/,
  );
  assert.match(
    nodeEditorSource,
    /\.node-description-field \.description-read-content {\s+width: 100%;[\s\S]*?padding: 10px var\(--node-metadata-text-inset\);/,
  );
  assert.match(
    nodeEditorSource,
    /\.node-description-field textarea {\s+min-height: 14px;[\s\S]*?padding: 10px calc\(var\(--node-metadata-text-inset\) - var\(--node-metadata-control-border-width\)\);/,
  );
});

test('node metadata footer stays content-sized and pinned below settings content', () => {
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');
  const sectionFooterStyles = nodeEditorSource.match(/\.section-footer \{(?<styles>[\s\S]*?)\n  \}/)?.groups?.styles;

  assert.ok(sectionFooterStyles);
  assert.match(sectionFooterStyles, /display: flex;/);
  assert.match(sectionFooterStyles, /flex-shrink: 0;/);
  assert.match(sectionFooterStyles, /justify-content: flex-end;/);
  assert.match(sectionFooterStyles, /padding: 0\.5em 1em 1em 1em;/);
  assert.doesNotMatch(sectionFooterStyles, /^\s*height:\s*24px;/m);
});

test('node settings panel uses regular UI typography outside embedded code editors', () => {
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');
  const defaultNodeEditorSource = readFileSync(join(componentsDir, 'editors', 'DefaultNodeEditor.tsx'), 'utf8');
  const panelContainerStyles = nodeEditorSource.match(/^  \.panel-container \{(?<styles>[\s\S]*?)\n  \}/m)?.groups
    ?.styles;
  const panelToggleHelperStyles = nodeEditorSource.match(
    /\.panel-container \.labeled-toggle-helper-label,\s+\.panel-container \.labeled-toggle-helper,\s+\.panel-container \.labeled-toggle-helper \* \{(?<styles>[\s\S]*?)\n  \}/,
  )?.groups?.styles;
  const sectionFooterStyles = nodeEditorSource.match(/\.section-footer \{(?<styles>[\s\S]*?)\n  \}/)?.groups?.styles;
  const titleReadContentStyles = nodeEditorSource.match(
    /\.node-title-field \.node-title-read-button \.title-read-content \{(?<styles>[\s\S]*?)\n  \}/,
  )?.groups?.styles;
  const metadataInputStyles = nodeEditorSource.match(
    /\.node-title-field input,\s+\.node-description-field textarea \{(?<styles>[\s\S]*?)\n  \}/,
  )?.groups?.styles;
  const defaultFieldLabelStyles = defaultNodeEditorSource.match(
    /\.row > :first-child label\[id\$='-label'\],\s+\.row \.editor-wrapper-wrapper > label \{(?<styles>[\s\S]*?)\n  \}/,
  )?.groups?.styles;
  const editorStatusLineStyles = defaultNodeEditorSource.match(/\.editor-status-line \{(?<styles>[\s\S]*?)\n  \}/)
    ?.groups?.styles;

  assert.ok(panelContainerStyles);
  assert.ok(panelToggleHelperStyles);
  assert.ok(sectionFooterStyles);
  assert.ok(titleReadContentStyles);
  assert.ok(metadataInputStyles);
  assert.ok(defaultFieldLabelStyles);
  assert.ok(editorStatusLineStyles);
  assert.match(panelContainerStyles, /font-family: var\(--font-family\);/);
  assert.match(panelContainerStyles, /--ds-font-family-body: var\(--font-family\);/);
  assert.match(panelContainerStyles, /--ds-font-family-heading: var\(--font-family\);/);
  assert.match(panelContainerStyles, /--ds-font-family-code: var\(--font-family-monospace\);/);
  assert.match(panelContainerStyles, /--label-font-family: var\(--font-family\);/);
  assert.match(panelContainerStyles, /border-left: 1px solid var\(--app-panel-border\);/);
  assert.match(panelContainerStyles, /box-shadow: none;/);
  assert.match(panelToggleHelperStyles, /font-size: var\(--ui-font-size-sm\) !important;/);
  assert.match(panelToggleHelperStyles, /line-height: 1\.35;/);
  assert.match(titleReadContentStyles, /color: var\(--foreground\);/);
  assert.match(defaultFieldLabelStyles, /color: var\(--label-color\);/);
  assert.doesNotMatch(sectionFooterStyles, /font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(titleReadContentStyles, /font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(metadataInputStyles, /font-family: var\(--font-family-monospace\);/);
  assert.doesNotMatch(editorStatusLineStyles, /font-family: var\(--font-family-monospace\);/);
});

test('node editor keeps selected-node editor identity stable across panel rerenders', () => {
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');

  assert.match(nodeEditorSource, /const nodeForEditor = useMemo\(/);
  assert.match(nodeEditorSource, /: selectedNode,\s+\[isVariant, selectedNode, selectedVariantData\]/);
});

test('node settings Escape hotkey lets editor-local popups close first', () => {
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');

  assert.match(
    nodeEditorSource,
    /useHotkeys\('esc', handleEscape, \{ ignoreEventWhen: \(event\) => event\.defaultPrevented \}, \[handleEscape\]\)/,
  );
});

test('node code editor lazy loading keeps the field shell visible', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');
  const defaultNodeEditorSource = readFileSync(join(componentsDir, 'editors', 'DefaultNodeEditor.tsx'), 'utf8');

  assert.match(defaultNodeEditorSource, /const editorLoadKey = `\$\{node\.id\}:\$\{node\.type\}`;/);
  assert.match(
    defaultNodeEditorSource,
    /editorState\?\.editorLoadKey === editorLoadKey \? editorState\.editors : \[\]/,
  );
  assert.match(codeEditorSource, /const CodeEditorLoadingFallback: FC = \(\) =>/);
  assert.match(codeEditorSource, /<Suspense fallback=\{<CodeEditorLoadingFallback \/>\}>/);
  assert.doesNotMatch(codeEditorSource, /<Suspense fallback=\{<div \/>\}>\s+<div className="editor-wrapper-wrapper">/);
  assert.match(defaultNodeEditorSource, /\.code-editor-loading-placeholder/);
});

test('node code editor is preloaded before settings need it', () => {
  const lazyComponentsSource = readFileSync(join(componentsDir, 'LazyComponents.tsx'), 'utf8');
  const graphBuilderSource = readFileSync(join(componentsDir, 'GraphBuilder.tsx'), 'utf8');
  const appSource = readFileSync(join(componentsDir, 'RivetApp.tsx'), 'utf8');

  assert.match(lazyComponentsSource, /export function preloadCodeEditor\(\): Promise<CodeEditorModule>/);
  assert.match(lazyComponentsSource, /codeEditorPreloadPromise = undefined;/);
  assert.match(lazyComponentsSource, /export function warmCodeEditor\(\): void/);
  assert.match(lazyComponentsSource, /const LazyCodeEditorImpl = lazy\(preloadCodeEditor\);/);
  assert.match(appSource, /requestIdleCallback\(preload, \{ timeout: 2500 \}\)/);
  assert.match(graphBuilderSource, /warmCodeEditor\(\);\s+setEditingNodeId\(node\.id\);/);
});

test('linked node settings entry points open the source library node', () => {
  const graphBuilderSource = readFileSync(join(componentsDir, 'GraphBuilder.tsx'), 'utf8');
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');
  const nodeLibraryBuilderSource = readFileSync(join(componentsDir, 'NodeLibraryBuilder.tsx'), 'utf8');
  const contextMenuHandlerSource = readFileSync(
    join(componentsDir, '..', 'hooks', 'useGraphBuilderContextMenuHandler.ts'),
    'utf8',
  );

  assert.match(
    graphBuilderSource,
    /if \(isNodePrefabInstanceNode\(node\)\) \{[\s\S]*openNodeLibrary\(\{[\s\S]*editingPrefabId: prefabId,[\s\S]*selectedNodeIds: sourceNode \? \[sourceNode\.id\] : \[\],[\s\S]*return;/,
  );
  assert.match(contextMenuHandlerSource, /const openLinkedNodeLibraryNode = useStableCallback/);
  assert.match(contextMenuHandlerSource, /\.with\('node-edit'[\s\S]*openLinkedNodeLibraryNode\(nodesById\[nodeId\]\)/);
  assert.match(
    contextMenuHandlerSource,
    /\.with\('node-open-prefab-source'[\s\S]*openLinkedNodeLibraryNode\(nodesById\[nodeId\]\)/,
  );
  assert.doesNotMatch(nodeEditorSource, /NodePrefabInstanceEditor/);
  assert.match(
    nodeEditorSource,
    /if \(selectedNode && isNodePrefabInstanceNode\(selectedNode\)\) \{[\s\S]*deselect\(\);/,
  );
  assert.match(nodeLibraryBuilderSource, /EditNodeCommandOverrideContext/);
  assert.match(nodeLibraryBuilderSource, /const editPrefabSourceNode: EditNodeCommand = useStableCallback/);
  assert.match(nodeLibraryBuilderSource, /prefabsBySourceNodeId\.get\(params\.nodeId\)/);
  assert.match(nodeLibraryBuilderSource, /updatePrefabSource\(prefab\.id,[\s\S]*structuredClone\(params\.newNode\)/);
  assert.match(nodeLibraryBuilderSource, /<EditNodeCommandOverrideContext\.Provider value=\{editPrefabSourceNode\}>/);
  assert.match(nodeLibraryBuilderSource, /const centeredEditingPrefabIdRef = useRef<NodePrefabId \| undefined>/);
  assert.match(
    nodeLibraryBuilderSource,
    /setCanvasPosition\(getCanvasPositionForNodes\(\[editingPrefab\.sourceNode\], sidebarOpen\)\);/,
  );
});

test('node color picker is not split into a fragile dev lazy module', () => {
  const lazyComponentsSource = readFileSync(join(componentsDir, 'LazyComponents.tsx'), 'utf8');
  const colorEditorSource = readFileSync(join(componentsDir, 'editors', 'ColorEditor.tsx'), 'utf8');

  assert.doesNotMatch(lazyComponentsSource, /TripleBarColorPicker/);
  assert.match(colorEditorSource, /import \{ TripleBarColorPicker \} from '\.\.\/TripleBarColorPicker';/);
  assert.doesNotMatch(colorEditorSource, /LazyTripleBarColorPicker|Suspense/);
});

test('default node color picker renders through color 0 without saving that token into projects', () => {
  const nodeColorPickerSource = readFileSync(join(componentsDir, 'NodeColorPicker.tsx'), 'utf8');
  const nodeEditorSource = readFileSync(join(componentsDir, 'NodeEditor.tsx'), 'utf8');
  const colorsSource = readFileSync(join(componentsDir, '..', 'colors.css'), 'utf8');

  assert.match(nodeColorPickerSource, /DEFAULT_NODE_HEADER_COLOR/);
  assert.match(nodeColorPickerSource, /PROJECT_DEFAULT_NODE_HEADER_COLOR/);
  assert.match(nodeColorPickerSource, /getNodeBorderReferenceColor\(currentColor\)/);
  assert.match(
    nodeColorPickerSource,
    /createBorderAndHeaderNodeColor\(color\.isDefault \? PROJECT_DEFAULT_NODE_HEADER_COLOR : color\.color\)/,
  );
  assert.match(nodeColorPickerSource, /color: var\(--node-color-picker-trigger-icon\);/);
  assert.match(nodeEditorSource, /border: 1px solid var\(--node-color-picker-trigger-border\);/);
  assert.match(colorsSource, /--node-color-picker-trigger-border: rgba\(255, 255, 255, 0\.1\);/);
  assert.match(colorsSource, /--node-color-picker-trigger-icon: rgba\(255, 255, 255, 0\.3\);/);
  assert.match(colorsSource, /--node-color-picker-swatch-body-bg: var\(--node-body-bg\);/);
  assert.match(nodeColorPickerSource, /background-color: var\(--node-color-picker-swatch-body-bg\);/);
  assert.match(
    colorsSource,
    /:root\.theme-bright,[\s\S]*--node-color-picker-trigger-border: rgba\(15, 23, 34, 0\.1\);/,
  );
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-color-picker-trigger-icon: rgba\(15, 23, 34, 0\.3\);/);
  assert.match(colorsSource, /:root\.theme-bright,[\s\S]*--node-color-picker-swatch-body-bg: #ffffff;/);
});

test('collapsible settings surfaces share opaque colors across panels and modals', () => {
  const colorsSource = readFileSync(join(componentsDir, '..', 'colors.css'), 'utf8');
  const editorGroupSource = readFileSync(join(componentsDir, 'editors', 'EditorGroup.tsx'), 'utf8');
  const projectInfoModalSource = readFileSync(join(componentsDir, 'ProjectInfoModal.tsx'), 'utf8');
  const aiAssistEditorSource = readFileSync(join(componentsDir, 'editors', 'custom', 'AiAssistEditorBase.tsx'), 'utf8');

  assert.match(
    colorsSource,
    /--surface-border: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darkish\) [^)]+\);/,
  );
  assert.match(colorsSource, /--settings-collapsible-border: var\(--surface-border\);/);
  assert.match(
    colorsSource,
    /--settings-collapsible-header-bg: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darker-darker\) [^)]+\);/,
  );
  assert.match(
    colorsSource,
    /--settings-collapsible-body-bg: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darker\) [^)]+\);/,
  );
  assert.match(
    colorsSource,
    /--settings-collapsible-hover-bg: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darkish\) [^)]+\);/,
  );
  assert.match(
    colorsSource,
    /--form-control-bg: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darker-darker\) [^)]+\);/,
  );
  assert.match(
    colorsSource,
    /--form-control-border: color-mix\(in srgb, var\(--secondary\) [^,]+, var\(--grey-darkish\) [^)]+\);/,
  );
  assert.match(
    colorsSource,
    /--form-control-border-focus: color-mix\(in srgb, var\(--primary\) [^,]+, var\(--grey-darkish\) [^)]+\);/,
  );

  for (const source of [editorGroupSource, projectInfoModalSource, aiAssistEditorSource]) {
    assert.match(source, /border: 1px solid var\(--settings-collapsible-border\);/);
    assert.match(source, /background: var\(--settings-collapsible-header-bg\);/);
    assert.match(source, /background: var\(--settings-collapsible-body-bg\);/);
    assert.match(source, /background: var\(--settings-collapsible-hover-bg\);/);
  }
});

test('node header warning state stays scoped to warning-specific canvas nodes', () => {
  const visualNodeSource = readFileSync(join(componentsDir, 'VisualNode.tsx'), 'utf8');
  const visualNodeImplSource = sliceSourceBetween(
    visualNodeSource,
    'const VisualNodeImpl = memo(',
    'const GetGlobalVisualNode = memo(',
  );
  const getGlobalVisualNodeSource = sliceSourceBetween(
    visualNodeSource,
    'const GetGlobalVisualNode = memo(',
    'const GraphOutputVisualNode = memo(',
  );
  const graphOutputVisualNodeSource = sliceSourceBetween(
    visualNodeSource,
    'const GraphOutputVisualNode = memo(',
    'const SubGraphVisualNode = memo(',
  );
  const subGraphVisualNodeSource = sliceSourceBetween(
    visualNodeSource,
    'const SubGraphVisualNode = memo(',
    'export const VisualNode = memo(',
  );

  assert.match(visualNodeSource, /const VisualNodeImpl = memo\(/);
  assert.match(visualNodeSource, /const GetGlobalVisualNode = memo\(/);
  assert.match(visualNodeSource, /const GraphOutputVisualNode = memo\(/);
  assert.match(visualNodeSource, /const SubGraphVisualNode = memo\(/);
  assert.match(visualNodeSource, /props\.node\.type === 'getGlobal'/);
  assert.match(visualNodeSource, /props\.node\.type === 'graphOutput'/);
  assert.match(visualNodeSource, /props\.node\.type === 'subGraph'/);
  assert.match(getGlobalVisualNodeSource, /enabledStaticGlobalVariableIdsState/);
  assert.match(graphOutputVisualNodeSource, /duplicateGraphOutputIdsState/);
  assert.match(subGraphVisualNodeSource, /graphMetadataState/);
  assert.match(subGraphVisualNodeSource, /getRecursiveSubGraphWarning/);
  assert.doesNotMatch(visualNodeImplSource, /enabledStaticGlobalVariableIdsState/);
  assert.doesNotMatch(visualNodeImplSource, /duplicateGraphOutputIdsState/);
  assert.doesNotMatch(visualNodeImplSource, /getRecursiveSubGraphWarning/);
});

function sliceSourceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const startIndex = source.indexOf(startNeedle);
  const endIndex = source.indexOf(endNeedle);

  assert.notEqual(startIndex, -1, `Missing source marker: ${startNeedle}`);
  assert.notEqual(endIndex, -1, `Missing source marker: ${endNeedle}`);
  assert.ok(startIndex < endIndex, `Expected ${startNeedle} to appear before ${endNeedle}`);

  return source.slice(startIndex, endIndex);
}

test('node code editor uses project-scoped Monaco model caching', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');
  const lazyCodeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const workspaceHostCleanupSource = readFileSync(
    join(componentsDir, '..', 'hooks', 'workspaceHost', 'useWorkspaceHostProjectCleanup.ts'),
    'utf8',
  );
  const workspaceHostOpenSource = readFileSync(
    join(componentsDir, '..', 'hooks', 'workspaceHost', 'useWorkspaceHostOpenProject.ts'),
    'utf8',
  );
  const workspaceHostCloseSource = readFileSync(
    join(componentsDir, '..', 'hooks', 'workspaceHost', 'useWorkspaceHostCloseProject.ts'),
    'utf8',
  );

  assert.match(codeEditorSource, /buildCodeEditorModelCacheKey/);
  assert.match(codeEditorSource, /codeEditorModelCacheKey\.js/);
  assert.doesNotMatch(codeEditorSource, /codeEditorModelCache\.js/);
  assert.match(codeEditorSource, /projectId: project\.metadata\.id/);
  assert.match(codeEditorSource, /graphId: graphMetadata\?\.id/);
  assert.match(codeEditorSource, /editorMountKey[\s\S]*modelCacheKey \?\? 'uncached-model'/);
  assert.match(codeEditorSource, /modelCacheKey=\{modelCacheKey\}/);
  assert.match(lazyCodeEditorSource, /getOrCreateCodeEditorModel/);
  assert.match(lazyCodeEditorSource, /getCodeEditorViewState/);
  assert.match(lazyCodeEditorSource, /saveCodeEditorViewState/);
  assert.match(
    lazyCodeEditorSource,
    /const modelUri = modelCacheKey \? monaco\.Uri\.parse\(getCodeEditorModelUri\(modelCacheKey\)\) : undefined/,
  );
  assert.match(
    lazyCodeEditorSource,
    /getExistingModel: modelUri \? \(\) => monaco\.editor\.getModel\(modelUri\) : undefined/,
  );
  assert.match(
    lazyCodeEditorSource,
    /if \(model\.getValue\(\) !== text\) \{\s+currentOnChange\?\.\(model\.getValue\(\)\);/,
  );
  assert.match(lazyCodeEditorSource, /editor\.restoreViewState\(cachedViewState\);/);
  assert.match(lazyCodeEditorSource, /saveCodeEditorViewState\(modelCacheKey, editor\.saveViewState\(\)\);/);
  assert.match(lazyCodeEditorSource, /if \(!isCached\) \{\s+model\.dispose\(\);/);
  assert.match(workspaceHostCleanupSource, /function clearCodeEditorModelCacheForClosedProject/);
  assert.match(workspaceHostOpenSource, /cleanupClosedProject\(replacedProjectId\);/);
  assert.match(workspaceHostCloseSource, /cleanupClosedProject\(projectId,/);
});

test('node code editor text stats are editor-definition driven', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');

  assert.match(codeEditorSource, /showTextStats: 'showTextStats' in editorDef && editorDef\.showTextStats === true,/);
  assert.doesNotMatch(codeEditorSource, /node\.type === 'text' && editorDef\.dataKey === 'text'/);
});

test('node code editor spellcheck is Monaco context-menu driven', () => {
  const nodeEditorCodeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');
  const lazyCodeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const defaultNodeEditorSource = readFileSync(join(componentsDir, 'editors', 'DefaultNodeEditor.tsx'), 'utf8');
  const spellcheckSource = readFileSync(join(componentsDir, '..', 'utils', 'monaco', 'spellcheck.ts'), 'utf8');

  assert.doesNotMatch(nodeEditorCodeEditorSource, /shouldEnableSpellcheck/);
  assert.match(nodeEditorCodeEditorSource, /runCodeEditorSpellcheck\(editor\)/);
  assert.doesNotMatch(nodeEditorCodeEditorSource, /enableSpellcheckAction=\{/);
  assert.match(nodeEditorCodeEditorSource, /onSpellcheckAction=\{handleCheckSpelling\}/);
  assert.match(
    nodeEditorCodeEditorSource,
    /if \(spellcheckRunId\.current === runId\) \{[\s\S]*setSpellcheckStatus\(\{ type: 'done', result \}\);[\s\S]*\} else \{[\s\S]*clearCodeEditorSpellcheckMarkers\(editor\);/,
  );
  assert.doesNotMatch(nodeEditorCodeEditorSource, />\s+Check spelling\s+<\/button>/);
  assert.match(nodeEditorCodeEditorSource, /className="editor-spellcheck-status"/);
  assert.match(lazyCodeEditorSource, /enableSpellcheckAction\?: boolean;/);
  assert.match(lazyCodeEditorSource, /onSpellcheckAction\?: \(\) => void \| Promise<void>;/);
  assert.match(lazyCodeEditorSource, /enableSpellcheckAction = true/);
  assert.doesNotMatch(lazyCodeEditorSource, /hasSpellcheckAction/);
  assert.match(lazyCodeEditorSource, /!editor \|\| !enableSpellcheckAction/);
  assert.match(lazyCodeEditorSource, /editor\.addAction\(\{[\s\S]*id: 'rivet\.checkSpelling'/);
  assert.match(lazyCodeEditorSource, /label: 'Check spelling'/);
  assert.match(lazyCodeEditorSource, /contextMenuGroupId: 'navigation'/);
  assert.match(lazyCodeEditorSource, /const customSpellcheckAction = onSpellcheckActionLatest\.current/);
  assert.match(lazyCodeEditorSource, /await runCodeEditorSpellcheck\(editor\);/);
  assert.match(lazyCodeEditorSource, /clearCodeEditorSpellcheckMarkers\(editor\);[\s\S]*onChangeLatest\.current/);
  assert.match(lazyCodeEditorSource, /clearCodeEditorSpellcheckMarkers\(editor\);[\s\S]*editor\.dispose\(\);/);
  assert.doesNotMatch(defaultNodeEditorSource, /\.node-editor-spellcheck-button/);
  assert.doesNotMatch(defaultNodeEditorSource, /\.node-editor-code-header-label-empty/);
  assert.doesNotMatch(spellcheckSource, /SPELLCHECK_LANGUAGES/);
  assert.doesNotMatch(spellcheckSource, /getLanguageId\(\)/);
  assert.match(
    spellcheckSource,
    /import\('nspell'\)[\s\S]*import\('dictionary-en'\)[\s\S]*import\('rivet-cspell-words'\)/,
  );
  assert.doesNotMatch(nodeEditorCodeEditorSource, /import\('nspell'\)|import\('dictionary-en'\)/);
});

test('shared Monaco code editor exposes local text tools through context menu actions', () => {
  const lazyCodeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const textTransformsSource = readFileSync(
    join(componentsDir, '..', 'utils', 'monaco', 'editorTextTransforms.ts'),
    'utf8',
  );

  assert.match(lazyCodeEditorSource, /registerEditorTextToolActions/);
  assert.match(lazyCodeEditorSource, /id: 'rivet\.prettify'/);
  assert.match(lazyCodeEditorSource, /label: 'Prettify'/);
  assert.match(lazyCodeEditorSource, /editor\.action\.formatSelection/);
  assert.match(lazyCodeEditorSource, /editor\.action\.formatDocument/);
  assert.doesNotMatch(lazyCodeEditorSource, /from ['"]prettier['"]/);
  assert.match(lazyCodeEditorSource, /id: 'rivet\.jsonEscapeSelection'/);
  assert.match(lazyCodeEditorSource, /label: 'JSON escape'/);
  assert.match(lazyCodeEditorSource, /id: 'rivet\.jsonUnescapeSelection'/);
  assert.match(lazyCodeEditorSource, /label: 'JSON unescape'/);
  assert.match(lazyCodeEditorSource, /jsonEscapeText/);
  assert.match(lazyCodeEditorSource, /jsonUnescapeText/);
  assert.match(lazyCodeEditorSource, /editor\.executeEdits\('rivet\.textTools'/);
  assert.match(lazyCodeEditorSource, /editor\.pushUndoStop\(\);[\s\S]*editor\.executeEdits/);
  assert.doesNotMatch(lazyCodeEditorSource, /document\.execCommand|navigator\.clipboard/);
  assert.match(textTransformsSource, /normalizeEditorLineEndings/);
  assert.match(textTransformsSource, /text\.replace\(\/\\r\\n\?\/g, '\\n'\)/);
  assert.match(textTransformsSource, /JSON\.stringify\(normalizeEditorLineEndings\(text\)\)\.slice\(1, -1\)/);
  assert.match(textTransformsSource, /JSON\.parse\(`"\$\{text\}"`\)/);
});

test('node settings code editors use the active app display theme', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');

  assert.match(codeEditorSource, /import \{ resolveMonacoDisplayTheme \} from '\.\.\/codeEditorTheme\.js';/);
  assert.match(codeEditorSource, /const resolvedTheme = resolveMonacoDisplayTheme\(theme, appTheme\);/);
  assert.doesNotMatch(codeEditorSource, /const resolvedTheme = resolveMonacoTheme\(theme, appTheme\);/);
});

test('node code editor lets panel scrolling continue at editor scroll edges', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');

  const scrollbarBlocks = [
    ...codeEditorSource.matchAll(/scrollbar: \{\s+\.\.\.scrollbar,\s+alwaysConsumeMouseWheel: false,\s+\},/g),
  ];

  assert.equal(scrollbarBlocks.length, 2);
});

test('node Markdown code editors opt into Monaco folding', () => {
  const nodeEditorCodeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');
  const codeEditorMonacoSource = readFileSync(
    join(componentsDir, '..', 'utils', 'monaco', 'codeEditorMonaco.ts'),
    'utf8',
  );

  assert.match(nodeEditorCodeEditorSource, /shouldEnableMarkdownFolding/);
  assert.match(
    nodeEditorCodeEditorSource,
    /const effectiveEnableFolding = enableFolding \|\| shouldEnableMarkdownFolding\(language\);/,
  );
  assert.match(nodeEditorCodeEditorSource, /enableFolding=\{effectiveEnableFolding\}/);
  assert.match(codeEditorMonacoSource, /registerMarkdownFoldingProviders/);
  assert.match(codeEditorMonacoSource, /MARKDOWN_FOLDING_LANGUAGES/);
  assert.match(codeEditorMonacoSource, /registerFoldingRangeProvider/);
});

test('readonly display code editors keep Monaco model text synchronized', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');

  assert.match(codeEditorSource, /!isReadonly \|\| onChangeLatest\.current \|\| modelCacheKey/);
  assert.match(codeEditorSource, /model\.setValue\(text\);[\s\S]*editor\.layout\(\);/);
});

test('node code editor popup widgets are allowed outside the rounded editor shell', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const defaultNodeEditorSource = readFileSync(join(componentsDir, 'editors', 'DefaultNodeEditor.tsx'), 'utf8');

  assert.doesNotMatch(codeEditorSource, /fixedOverflowWidgets/);
  assert.match(defaultNodeEditorSource, /\.editor-wrapper \{[\s\S]*?overflow: visible;/);
  assert.match(
    defaultNodeEditorSource,
    /\.editor-container \{[\s\S]*?border-radius: inherit;[\s\S]*?overflow: visible;/,
  );
  assert.match(
    defaultNodeEditorSource,
    /\.node-editor-static-code-editor \.editor-container \{[\s\S]*?overflow: visible;/,
  );
});

test('node settings JSON code editors expose unescaped string previews', () => {
  const nodeEditorCodeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');

  assert.match(nodeEditorCodeEditorSource, /JsonStringPreviewAffordance/);
  assert.match(nodeEditorCodeEditorSource, /function shouldEnableJsonStringPreview/);
  assert.match(nodeEditorCodeEditorSource, /return language === 'json';/);
  assert.match(nodeEditorCodeEditorSource, /type MountedEditorState = \{/);
  assert.match(nodeEditorCodeEditorSource, /const \[mountedEditorState, setMountedEditorState\] = useState/);
  assert.match(
    nodeEditorCodeEditorSource,
    /mountedEditorState\?\.editorMountKey === editorMountKey \? mountedEditorState\.editor : undefined/,
  );
  assert.match(nodeEditorCodeEditorSource, /setMountedEditorState\(\{ editor, editorMountKey \}\)/);
  assert.match(nodeEditorCodeEditorSource, /onEditorMount=\{handleEditorMount\}/);
  assert.doesNotMatch(nodeEditorCodeEditorSource, /setMountedEditor\(undefined\)/);
  assert.match(nodeEditorCodeEditorSource, /onEditorMount=\{onEditorMount\}/);
  assert.match(nodeEditorCodeEditorSource, /buttonCoordinateMode="root"/);
  assert.doesNotMatch(nodeEditorCodeEditorSource, /buttonAnchor="visible-position"/);
  assert.match(nodeEditorCodeEditorSource, /editor=\{editorProps\.mountedEditor\}/);
  assert.match(nodeEditorCodeEditorSource, /enabled=\{jsonPreviewEnabled\}/);
  assert.match(nodeEditorCodeEditorSource, /minDecodedLength=\{0\}/);
  assert.match(nodeEditorCodeEditorSource, /rootRef=\{rootRef\}/);
  assert.match(nodeEditorCodeEditorSource, /text=\{editorProps\.text\}/);
  assert.doesNotMatch(nodeEditorCodeEditorSource, /node-settings-json-string-preview|widgetId|data-widget-id/);
});

test('node settings code editors own footer font controls and AI assist trigger placement', () => {
  const defaultNodeEditorSource = readFileSync(join(componentsDir, 'editors', 'DefaultNodeEditor.tsx'), 'utf8');
  const defaultNodeEditorFieldSource = readFileSync(
    join(componentsDir, 'editors', 'DefaultNodeEditorField.tsx'),
    'utf8',
  );
  const editorGroupSource = readFileSync(join(componentsDir, 'editors', 'EditorGroup.tsx'), 'utf8');
  const codeEditorAiAssistSource = readFileSync(join(componentsDir, 'editors', 'CodeEditorAiAssist.tsx'), 'utf8');
  const editorUtilsSource = readFileSync(join(componentsDir, 'editors', 'editorUtils.ts'), 'utf8');
  const nodeEditorCodeEditorSource = readFileSync(join(componentsDir, 'editors', 'CodeEditor.tsx'), 'utf8');
  const aiAssistEditorSource = readFileSync(join(componentsDir, 'editors', 'custom', 'AiAssistEditorBase.tsx'), 'utf8');
  const fontSizeHookSource = readFileSync(join(componentsDir, '..', 'hooks', 'useMultilineEditorFontSize.ts'), 'utf8');

  assert.match(defaultNodeEditorSource, /const AI_ASSIST_TARGET_DATA_KEYS: Record<string, string> = \{/);
  assert.match(defaultNodeEditorSource, /PromptNodeAiAssist: 'promptText'/);
  assert.match(defaultNodeEditorSource, /GptFunctionNodeJsonSchemaAiAssist: 'schema'/);
  assert.match(defaultNodeEditorSource, /NodeCodeEditorWithAiAssist/);
  assert.match(defaultNodeEditorSource, /NodeCodeEditorWithGenericAiAssist/);
  assert.match(defaultNodeEditorSource, /codeEditorFooterLeft=\{footerLeftAction\}/);
  assert.match(defaultNodeEditorSource, /if \(row\.editor\.type === 'code'\)/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-footer \{/);
  assert.match(defaultNodeEditorSource, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-footer-center \{/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-font-button \{/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-ai-footer-button \{/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-ai-footer-button svg \{/);
  assert.match(defaultNodeEditorSource, /\.node-editor-code-ai-pair > \.row:empty \{/);
  assert.doesNotMatch(defaultNodeEditorSource, /\.node-editor-code-ai-pair > \.row\.custom:not\(:empty\)/);

  assert.match(defaultNodeEditorFieldSource, /codeEditorFooterLeft\?: ReactNode;/);
  assert.match(defaultNodeEditorFieldSource, /footerLeft=\{codeEditorFooterLeft\}/);

  assert.match(editorGroupSource, /CodeEditorAiAssistBridge/);
  assert.match(editorGroupSource, /GenericCodeEditorAiAssist/);
  assert.match(editorGroupSource, /if \(editor\.type === 'code'\)/);
  assert.match(editorGroupSource, /\.editor-group > \.node-editor-code-ai-pair:not\(:last-child\)/);

  assert.match(editorUtilsSource, /export function getCodeEditorDataKey/);

  assert.match(codeEditorAiAssistSource, /export const CodeEditorAiAssistBridge/);
  assert.match(codeEditorAiAssistSource, /export const GenericCodeEditorAiAssist/);
  assert.match(codeEditorAiAssistSource, /NodeCodeEditorFooterActionContext\.Provider/);
  assert.match(codeEditorAiAssistSource, /setSelectedTextGetter/);
  assert.match(codeEditorAiAssistSource, /getSelectedText: \(\) => selectedTextGetter\.current\?\.\(\)/);
  assert.match(codeEditorAiAssistSource, /graphName="Text Node Generator"/);
  assert.match(codeEditorAiAssistSource, /buildGeneratorPrompt=\{\(prompt, context\) =>/);
  assert.match(codeEditorAiAssistSource, /selectedText: context\.selectedText/);
  assert.match(codeEditorAiAssistSource, /<selected_editor_content>/);
  assert.match(codeEditorAiAssistSource, /function getNodeTypeInstruction/);
  assert.match(codeEditorAiAssistSource, /case 'codeNew'/);
  assert.match(codeEditorAiAssistSource, /case 'llmChatV2'/);
  assert.match(codeEditorAiAssistSource, /Generate content appropriate for the/);
  assert.match(codeEditorAiAssistSource, /dataKey === 'expression'/);
  assert.match(codeEditorAiAssistSource, /\[dataKey\]: output/);

  assert.match(nodeEditorCodeEditorSource, /useMultilineEditorFontSize/);
  assert.match(nodeEditorCodeEditorSource, /NodeCodeEditorFooterActionContext/);
  assert.match(nodeEditorCodeEditorSource, /function getSelectedEditorText/);
  assert.match(nodeEditorCodeEditorSource, /footerActionBridge\.setSelectedTextGetter/);
  assert.match(nodeEditorCodeEditorSource, /const footerCenter = \(textStats \|\| spellcheckStatusMessage\) && \(/);
  assert.match(nodeEditorCodeEditorSource, /center=\{footerCenter\}/);
  assert.match(nodeEditorCodeEditorSource, /Font size: \{fontSize\}px/);
  assert.match(nodeEditorCodeEditorSource, /onAdjustFontSize\('increase'\)|onAdjustFontSize\(command\)/);
  assert.match(nodeEditorCodeEditorSource, /onAdjustFontSize\('decrease'\)|onAdjustFontSize\(command\)/);
  assert.match(nodeEditorCodeEditorSource, /\{editorProps\.footer\}/);
  assert.match(nodeEditorCodeEditorSource, /className="editor-viewport-shell node-editor-static-code-editor"/);

  assert.match(aiAssistEditorSource, /NodeCodeEditorFooterActionContext/);
  assert.match(aiAssistEditorSource, /buildGeneratorPrompt\?: \(prompt: string, context: \{ selectedText\?: string \}\) => string;/);
  assert.match(aiAssistEditorSource, /resolveAiAssistModelSettings/);
  assert.match(aiAssistEditorSource, /const assistModel = resolveAiAssistModelSettings/);
  assert.match(aiAssistEditorSource, /const generationAssistModel = resolveAiAssistModelSettings/);
  assert.doesNotMatch(aiAssistEditorSource, /settingsOverride/);
  assert.doesNotMatch(aiAssistEditorSource, /replaceAiAssistGeneratorLegacyChatNodes/);
  assert.match(aiAssistEditorSource, /createAiAssistVercelGeneratorChatNodeDefinition\(generationAssistModel\)/);
  assert.doesNotMatch(aiAssistEditorSource, /new ExecutionRecorder/);
  assert.doesNotMatch(aiAssistEditorSource, /nativeCreateDir|nativeWriteFile|AppLog/);
  assert.doesNotMatch(aiAssistEditorSource, /corePlugins\.anthropic/);
  assert.doesNotMatch(aiAssistEditorSource, /registerPlugin/);
  assert.match(aiAssistEditorSource, /const buildPromptInput = \(\) => \{/);
  assert.match(aiAssistEditorSource, /footerActionBridge\.getSelectedText\(\)/);
  assert.match(aiAssistEditorSource, /<selected_editor_content>/);
  assert.match(aiAssistEditorSource, /prompt: buildPromptInput\(\)/);
  assert.match(aiAssistEditorSource, /model: generationAssistModel\.model/);
  assert.match(aiAssistEditorSource, /api: generationAssistModel\.graphApi/);
  assert.match(
    aiAssistEditorSource,
    /Using <strong>\{assistModel\.displayName\}<\/strong>\. To change it, go to Settings &gt; LLM\./,
  );
  assert.doesNotMatch(aiAssistEditorSource, /<Select/);
  assert.doesNotMatch(aiAssistEditorSource, /modelSelectorOptions/);
  assert.doesNotMatch(aiAssistEditorSource, /setModelAndApi/);
  assert.match(aiAssistEditorSource, /ai-sparks-solid\.svg\?react/);
  assert.match(aiAssistEditorSource, /<Tooltip content=\{footerLabel\} tag="span">/);
  assert.match(aiAssistEditorSource, /aria-label=\{footerLabel\}/);
  assert.match(aiAssistEditorSource, /<SparklesIcon \/>/);
  assert.match(aiAssistEditorSource, /Modal, \{ ModalBody, ModalFooter, ModalTransition \}/);
  assert.match(aiAssistEditorSource, /AppModalHeader/);
  assert.match(
    aiAssistEditorSource,
    /const footerLabel = label === 'Generate Using AI' \? 'Generate using AI' : label;/,
  );
  assert.match(aiAssistEditorSource, /const \[footerModalOpen, setFooterModalOpen\] = useState\(false\);/);
  assert.match(aiAssistEditorSource, /const generationInFlightRef = useRef\(false\);/);
  assert.match(aiAssistEditorSource, /const activeGenerationIdRef = useRef<symbol \| null>\(null\);/);
  assert.match(aiAssistEditorSource, /const abortControllerRef = useRef<AbortController \| null>\(null\);/);
  assert.match(aiAssistEditorSource, /const isMountedRef = useRef\(true\);/);
  assert.match(aiAssistEditorSource, /const currentNodeIdRef = useRef\(node\.id\);/);
  assert.match(aiAssistEditorSource, /const latestNodeRef = useRef\(node\);/);
  assert.match(aiAssistEditorSource, /const latestDataRef = useRef\(data\);/);
  assert.match(aiAssistEditorSource, /latestNodeRef\.current = node;/);
  assert.match(aiAssistEditorSource, /latestDataRef\.current = data;/);
  assert.match(aiAssistEditorSource, /const AI_ASSIST_CANCEL_REASON = 'Generate using AI canceled';/);
  assert.match(aiAssistEditorSource, /const abortGeneration = \(\) => \{[\s\S]*abortControllerRef\.current\?\.abort\(AI_ASSIST_CANCEL_REASON\);/);
  assert.match(aiAssistEditorSource, /const closeFooterModal = \(\) => \{[\s\S]*abortGeneration\(\);[\s\S]*setFooterModalOpen\(false\);/);
  assert.match(
    aiAssistEditorSource,
    /isMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*isMountedRef\.current = false;[\s\S]*abortControllerRef\.current\?\.abort\(AI_ASSIST_CANCEL_REASON\);/,
  );
  assert.match(
    aiAssistEditorSource,
    /if \(currentNodeIdRef\.current === node\.id\) \{[\s\S]*return;[\s\S]*\}[\s\S]*abortControllerRef\.current\?\.abort\(AI_ASSIST_CANCEL_REASON\);[\s\S]*activeGenerationIdRef\.current = null;[\s\S]*generationInFlightRef\.current = false;/,
  );
  assert.match(aiAssistEditorSource, /setFooterModalOpen\(false\);[\s\S]*setSelectedTextContext\(undefined\);/);
  assert.match(
    aiAssistEditorSource,
    /if \(isReadonly \|\| isDisabled \|\| assistModel\.missingConfiguration \|\| generationInFlightRef\.current\)/,
  );
  assert.match(aiAssistEditorSource, /const generationId = Symbol\('ai-assist-generation'\);/);
  assert.match(aiAssistEditorSource, /const generationNodeId = node\.id;/);
  assert.match(aiAssistEditorSource, /const abortController = new AbortController\(\);/);
  assert.match(
    aiAssistEditorSource,
    /const isCurrentGenerationCanceled = \(\) =>[\s\S]*abortController\.signal\.aborted \|\|[\s\S]*activeGenerationIdRef\.current !== generationId \|\|[\s\S]*latestNodeRef\.current\.id !== generationNodeId;/,
  );
  assert.match(aiAssistEditorSource, /activeGenerationIdRef\.current = generationId;/);
  assert.match(aiAssistEditorSource, /abortControllerRef\.current = abortController;/);
  assert.match(aiAssistEditorSource, /generationInFlightRef\.current = true;[\s\S]*setWorking\(true\);/);
  assert.match(
    aiAssistEditorSource,
    /if \(isCurrentGenerationCanceled\(\)\) \{[\s\S]*return;[\s\S]*\}[\s\S]*registry\.register\(createAiAssistVercelGeneratorChatNodeDefinition\(generationAssistModel\)\);/,
  );
  assert.match(aiAssistEditorSource, /abortSignal: abortController\.signal/);
  assert.match(aiAssistEditorSource, /if \(isCurrentGenerationCanceled\(\)\) \{[\s\S]*return;/);
  assert.match(aiAssistEditorSource, /if \(abortController\.signal\.aborted\) \{[\s\S]*return;/);
  assert.match(
    aiAssistEditorSource,
    /if \(activeGenerationIdRef\.current === generationId\) \{[\s\S]*activeGenerationIdRef\.current = null;[\s\S]*abortControllerRef\.current = null;[\s\S]*generationInFlightRef\.current = false;/,
  );
  assert.match(aiAssistEditorSource, /if \(isMountedRef\.current\) \{[\s\S]*setWorking\(false\);/);
  assert.match(
    aiAssistEditorSource,
    /const generateDisabled = isReadonly \|\| isDisabled \|\| working \|\| Boolean\(assistModel\.missingConfiguration\);/,
  );
  assert.match(aiAssistEditorSource, /const baseNode = latestNodeRef\.current\.id === node\.id/);
  assert.match(aiAssistEditorSource, /const baseData = latestNodeRef\.current\.id === node\.id/);
  assert.match(aiAssistEditorSource, /const updatedData = updateData\(baseData, outputs\);/);
  assert.match(aiAssistEditorSource, /\.\.\.baseNode,/);
  assert.match(
    aiAssistEditorSource,
    /onClick=\{\(\) => \{[\s\S]*setSelectedTextContext\(footerActionBridge\.getSelectedText\(\)\);[\s\S]*setFooterModalOpen\(true\);[\s\S]*\}\}/,
  );
  assert.match(
    aiAssistEditorSource,
    /<Modal autoFocus=\{false\} onClose=\{closeFooterModal\} width="large">/,
  );
  assert.match(aiAssistEditorSource, /<AppModalHeader title=\{footerLabel\} onClose=\{closeFooterModal\} \/>/);
  assert.match(
    aiAssistEditorSource,
    /className="ai-assist-modal-panel"[\s\S]*\{renderPromptTextArea\(4,[\s\S]*\{modelNote\}/,
  );
  assert.match(aiAssistEditorSource, /renderPromptTextArea\(4, 'What should Rivet generate\?'\)/);
  assert.match(aiAssistEditorSource, /resize="vertical"/);
  assert.match(aiAssistEditorSource, /if \(!generateDisabled && e\.key === 'Enter'/);
  assert.match(aiAssistEditorSource, /void generate\(\);/);
  assert.match(aiAssistEditorSource, /const cancelButton = working \? \(/);
  assert.match(aiAssistEditorSource, /<Button aria-label="Cancel generation" onClick=\{abortGeneration\}>/);
  assert.match(aiAssistEditorSource, /\{cancelButton\}/);
  assert.match(aiAssistEditorSource, /<ModalFooter>[\s\S]*<Button appearance="primary"[\s\S]*Generate/);
  assert.match(aiAssistEditorSource, /\.ai-assist-textarea-shell \+ \.ai-assist-model-note \{[\s\S]*margin-top:/);
  assert.doesNotMatch(aiAssistEditorSource, /\.ai-assist-modal-panel \.ai-assist-model-note \{[\s\S]*margin-bottom:/);
  assert.match(aiAssistEditorSource, /\.ai-assist-textarea-shell \{[\s\S]*width: 100%;/);
  assert.match(
    aiAssistEditorSource,
    /\.ai-assist-textarea-shell textarea \{[\s\S]*border-radius: var\(--ui-button-radius\);/,
  );
  assert.doesNotMatch(aiAssistEditorSource, /model-and-button/);
  assert.doesNotMatch(aiAssistEditorSource, /ai-assist-footer-panel/);
  assert.doesNotMatch(aiAssistEditorSource, /setFooterPanelOpen/);

  assert.match(fontSizeHookSource, /adjustFontSize/);
  assert.match(fontSizeHookSource, /return \{\s+fontSize: normalizedFontSize,\s+adjustFontSize,/);
});

test('lazy Monaco editor chunk stays independent from app UI state', () => {
  const codeEditorSource = readFileSync(join(componentsDir, 'CodeEditor.tsx'), 'utf8');
  const lazyComponentsSource = readFileSync(join(componentsDir, 'LazyComponents.tsx'), 'utf8');
  const legacyMonacoSource = readFileSync(join(componentsDir, '..', 'utils', 'monaco.ts'), 'utf8');
  const codeEditorMonacoSource = readFileSync(
    join(componentsDir, '..', 'utils', 'monaco', 'codeEditorMonaco.ts'),
    'utf8',
  );

  assert.match(lazyComponentsSource, /useMultilineEditorFontSize/);
  assert.match(lazyComponentsSource, /useIsNodeEditorResizing/);
  assert.match(codeEditorSource, /codeEditorMonaco/);
  assert.match(legacyMonacoSource, /definePITheme\('bright', \{ primary: '1769e0', base: 'vs' \}\);/);
  assert.match(codeEditorMonacoSource, /bright: \{ foreground: '1769e0', base: 'vs' \}/);
  assert.doesNotMatch(codeEditorSource, /useMultilineEditorFontSize/);
  assert.doesNotMatch(codeEditorSource, /NodeEditorResizeContext/);
  assert.doesNotMatch(codeEditorSource, /codeEditorTheme/);
  assert.doesNotMatch(codeEditorSource, /\.\.\/utils\/monaco\.js/);
  assert.doesNotMatch(codeEditorSource, /\.\.\/state\//);
});
