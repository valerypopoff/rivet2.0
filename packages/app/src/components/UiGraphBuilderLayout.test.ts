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
  const sharedStyles = readFileSync(
    join(rootDir, 'packages', 'core', 'src', 'model', 'UiGraphRendererStyles.ts'),
    'utf8',
  );

  assert.match(rendererSource, /RIVET_WEB_APP_RENDERER_CSS/);
  assert.match(rendererSource, /className="rivet-web-app-root"/);
  assert.match(sharedStyles, /\.rivet-web-app-card,\s+\.rivet-web-app-field \{/);
  assert.match(sharedStyles, /\.rivet-web-app-output-markdown\.markdown-body \{[\s\S]*background: transparent;/);
  assert.match(sharedStyles, /\.rivet-web-app-output-markdown\.markdown-body \{[\s\S]*font-family: inherit;/);
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
