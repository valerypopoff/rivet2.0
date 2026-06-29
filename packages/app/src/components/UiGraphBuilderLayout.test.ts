import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(componentsDir, '..', '..', '..', '..');

test('web app builder keeps empty component lists content-sized', () => {
  const source = readFileSync(join(componentsDir, 'UiGraphBuilder.tsx'), 'utf8');
  const scrollStyles = source.match(/\.ui-graph-builder-scroll \{(?<styles>[\s\S]*?)\n  \}/)?.groups?.styles;

  assert.ok(scrollStyles);
  assert.match(scrollStyles, /align-content: start;/);
  assert.match(scrollStyles, /grid-auto-rows: max-content;/);
});

test('web app preview renders input and textarea as card-backed bordered fields', () => {
  const rendererSource = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');
  const nodeHandlerSource = readFileSync(join(rootDir, 'packages', 'node', 'src', 'webAppHandler.ts'), 'utf8');
  const sharedStyles = readFileSync(
    join(rootDir, 'packages', 'core', 'src', 'model', 'UiGraphRendererStyles.ts'),
    'utf8',
  );

  assert.match(rendererSource, /RIVET_WEB_APP_RENDERER_CSS/);
  assert.match(rendererSource, /className="rivet-web-app-root"/);
  assert.match(sharedStyles, /--rivet-web-app-font-size: var\(--rivet-web-app-host-font-size, 15px\);/);
  assert.doesNotMatch(sharedStyles, /--rivet-web-app-font-size: var\(--ui-font-size-base/);
  assert.match(sharedStyles, /--rivet-web-app-button-radius: var\(--rivet-web-app-host-button-radius, 6px\);/);
  assert.doesNotMatch(sharedStyles, /--rivet-web-app-button-radius: var\(--ui-button-radius/);
  assert.match(sharedStyles, /font-size: var\(--rivet-web-app-font-size\);/);
  assert.match(sharedStyles, /\.rivet-web-app-card,\s+\.rivet-web-app-field \{/);
  assert.match(sharedStyles, /\.rivet-web-app-field \{[\s\S]*font-size: inherit;/);
  assert.match(sharedStyles, /\.rivet-web-app-output pre \{[\s\S]*font-family: ui-monospace,/);
  assert.match(sharedStyles, /\.rivet-web-app-output pre \{[\s\S]*font-size: inherit;/);
  assert.match(
    sharedStyles,
    /\.rivet-web-app-markdown\.markdown-body \{[\s\S]*background: var\(--rivet-web-app-card-background\);/,
  );
  assert.match(sharedStyles, /\.rivet-web-app-output-markdown\.markdown-body \{[\s\S]*background: transparent;/);
  assert.match(sharedStyles, /\.rivet-web-app-output-markdown\.markdown-body \{[\s\S]*font-family: inherit;/);
  assert.match(
    sharedStyles,
    /\.rivet-web-app-markdown\.markdown-body code,\s+\.rivet-web-app-output-markdown\.markdown-body code \{[\s\S]*font-family: ui-monospace,/,
  );
  assert.match(
    sharedStyles,
    /\.rivet-web-app-markdown\.markdown-body pre,\s+\.rivet-web-app-output-markdown\.markdown-body pre \{[\s\S]*white-space: pre-wrap;/,
  );
  assert.match(
    sharedStyles,
    /\.rivet-web-app-field input,\s+\.rivet-web-app-field textarea \{[\s\S]*border: 1px solid var\(--rivet-web-app-control-border\);/,
  );
  assert.match(
    sharedStyles,
    /\.rivet-web-app-field input,\s+\.rivet-web-app-field textarea \{[\s\S]*background: var\(--rivet-web-app-control-background\);/,
  );
  assert.match(rendererSource, /case 'input':[\s\S]*<label className="rivet-web-app-field">/);
  assert.match(rendererSource, /case 'textarea':[\s\S]*<label className="rivet-web-app-field">/);
  assert.match(rendererSource, /className="rivet-web-app-control inputarea"/);
  assert.match(nodeHandlerSource, /className: 'rivet-web-app-control inputarea'/);
});

test('web app output renderers keep missing output state blank', () => {
  const rendererSource = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');
  const nodeHandlerSource = readFileSync(join(rootDir, 'packages', 'node', 'src', 'webAppHandler.ts'), 'utf8');

  assert.match(rendererSource, /JSON\.stringify\(value, null, 2\) \?\? ''/);
  assert.doesNotMatch(rendererSource, /JSON\.stringify\(value \?\? null/);
  assert.match(nodeHandlerSource, /JSON\.stringify\(value, null, 2\) \?\? ''/);
  assert.doesNotMatch(nodeHandlerSource, /JSON\.stringify\(value \?\? null/);
});

test('web app desktop preview action is host-configurable', () => {
  const builderSource = readFileSync(join(componentsDir, 'UiGraphBuilder.tsx'), 'utf8');
  const hostUiConfigSource = readFileSync(
    join(rootDir, 'packages', 'app', 'src', 'providers', 'HostUiConfigContext.tsx'),
    'utf8',
  );

  assert.match(hostUiConfigSource, /webApps\?: \{\s+desktopPreview\?: boolean;/);
  assert.match(builderSource, /useRivetAppHostUiConfig/);
  assert.match(builderSource, /hostUiConfig\.webApps\?\.desktopPreview !== false/);
  assert.match(builderSource, /\{canRunDesktopPreview \? \(/);
  assert.match(builderSource, /ui-graph-builder-preview-action/);
  assert.match(builderSource, /BrowserIcon aria-hidden="true"/);
  assert.match(builderSource, /Run detached/);
  assert.doesNotMatch(builderSource, /<h1 className="ui-graph-builder-title">Web app<\/h1>/);
  assert.doesNotMatch(builderSource, /Run web app/);
});

test('web app renderer fills its parent so editor preview and preview windows own scrolling correctly', () => {
  const sharedStyles = readFileSync(
    join(rootDir, 'packages', 'core', 'src', 'model', 'UiGraphRendererStyles.ts'),
    'utf8',
  );
  const styles = sharedStyles.match(/export const RIVET_WEB_APP_RENDERER_CSS = `(?<styles>[\s\S]*?)`;/)?.groups?.styles;

  assert.ok(styles);
  assert.match(styles, /height: 100%;/);
  assert.doesNotMatch(styles, /height: 100vh;/);
  assert.match(styles, /overflow: auto;/);
});

test('web app markdown preview stays on the shared marked renderer', () => {
  const rendererSource = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');
  const useMarkdownSource = readFileSync(join(componentsDir, '..', 'hooks', 'useMarkdown.ts'), 'utf8');

  assert.match(useMarkdownSource, /from 'marked'/);
  assert.match(useMarkdownSource, /allowHtml\?: boolean;/);
  assert.match(useMarkdownSource, /getEscapedHtmlRenderer/);
  assert.match(rendererSource, /useMarkdown\(markdownText, markdownText != null, \{ allowHtml: false \}\)/);
});

test('web app builder reorders components from preview handles', () => {
  const source = readFileSync(join(componentsDir, 'UiGraphBuilder.tsx'), 'utf8');
  const rendererSource = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');

  assert.match(rendererSource, /renderComponentFrame\?\(props: RivetWebAppComponentFrameProps\): ReactNode;/);
  assert.match(rendererSource, /renderComponentFrame\(frameProps\)/);
  assert.match(source, /renderComponentFrame=\{\(frameProps\) => <SortablePreviewComponentFrame \{...frameProps\} \/>\}/);
  assert.match(source, /const SortablePreviewComponentFrame: FC<RivetWebAppComponentFrameProps>/);
  assert.match(source, /className="ui-graph-preview-drag-handle"/);
  assert.match(source, /\.ui-graph-preview-sortable-row \{[\s\S]*position: relative;/);
  assert.match(source, /\.ui-graph-preview-drag-handle \{[\s\S]*position: absolute;/);
  assert.match(source, /\.ui-graph-preview-drag-handle \{[\s\S]*top: 50%;/);
  assert.match(source, /\.ui-graph-preview-drag-handle \{[\s\S]*right: -66px;/);
  assert.doesNotMatch(source, /\.ui-graph-preview-drag-handle \{[\s\S]*left: -66px;/);
  assert.match(source, /\.ui-graph-preview-drag-handle \{[\s\S]*transform: translateY\(-50%\);/);
  assert.match(source, /width: 56px;/);
  assert.match(source, /height: 60px;/);
  assert.doesNotMatch(source, /grid-template-columns: 56px minmax\(0, 1fr\);/);
  assert.match(source, /transform: transform \? `translate3d\(0, \$\{transform\.y\}px, 0\)` : undefined/);
  assert.doesNotMatch(source, /ui-graph-component-drag-handle/);
  assert.doesNotMatch(source, /className="ui-graph-component-card-title" \{...attributes\} \{...listeners\}/);
});

test('web app button mappings are derived from graph boundary ids', () => {
  const source = readFileSync(join(componentsDir, 'UiGraphBuilder.tsx'), 'utf8');
  const sharedStyles = readFileSync(
    join(rootDir, 'packages', 'core', 'src', 'model', 'UiGraphRendererStyles.ts'),
    'utf8',
  );

  assert.match(source, /getGraphBoundary\(project, component\.action\.graphId\)/);
  assert.match(
    source,
    /const component = createUiComponent\(type, project\.metadata\.mainGraphId\);[\s\S]*normalizeButtonActionToGraphBoundary\(component, getGraphBoundary\(project, component\.action\.graphId\)\);[\s\S]*draft\.components\.push\(component\);/,
  );
  assert.match(source, /normalizeButtonActionToGraphBoundary\(button, nextBoundary\)/);
  assert.match(source, /normalizeButtonActionToGraphBoundary\(component, getGraphBoundary\(project, component\.action\.graphId\)\)/);
  assert.match(source, /alignInputRowsToBoundary\(boundary, rows\)/);
  assert.match(source, /alignOutputRowsToBoundary\(boundary, rows\)/);
  assert.match(source, /const dataKeyUsages = collectUiGraphDataKeyUsages\(uiGraph\)/);
  assert.match(source, /const dataKeyOptions = getUniqueDataKeyOptions\(dataKeyUsages\)/);
  assert.match(source, /Data key[\s\S]*isDataKeyAlreadyUsedEarlier\(dataKeyUsages, component\.stateKey/);
  assert.match(source, /case 'output': \{[\s\S]*<select[\s\S]*dataKeyOptions\.map/);
  assert.match(source, /Data key to send[\s\S]*<select[\s\S]*dataKeyOptions\.map/);
  assert.match(source, /className="ui-graph-action-mapping-block"/);
  assert.match(source, /Data key to save to[\s\S]*isDataKeyAlreadyUsedEarlier\(dataKeyUsages, row\.stateKey/);
  assert.match(source, /<div className="ui-graph-data-key-warning">This data key is already used\.<\/div>/);
  assert.match(source, /className="ui-graph-action-port-id" value=\{row\.inputKey\} readOnly disabled/);
  assert.match(source, /className="ui-graph-action-port-id" value=\{row\.outputKey \?\? ''\} readOnly disabled/);
  assert.match(source, /\.ui-graph-action-port-id:disabled \{[\s\S]*opacity: 0\.72;/);
  assert.match(source, /aria-label="Delete component"[\s\S]*&times;/);
  assert.doesNotMatch(source, /<option value="">All outputs<\/option>/);
  assert.doesNotMatch(source, /Add graph input/);
  assert.doesNotMatch(source, /Add graph output/);
  assert.doesNotMatch(source, /Delete graph input mapping/);
  assert.doesNotMatch(source, /Delete graph output mapping/);
  assert.match(source, /\.ui-graph-component-card-title \{[\s\S]*color: var\(--foreground\);/);
  assert.match(sharedStyles, /--rivet-web-app-output-title: var\(--rivet-web-app-foreground, #ffffff\);/);
});
