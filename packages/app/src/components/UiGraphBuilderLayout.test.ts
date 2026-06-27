import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('web app builder keeps empty component lists content-sized', () => {
  const source = readFileSync(join(componentsDir, 'UiGraphBuilder.tsx'), 'utf8');
  const scrollStyles = source.match(/\.ui-graph-builder-scroll \{(?<styles>[\s\S]*?)\n  \}/)?.groups?.styles;

  assert.ok(scrollStyles);
  assert.match(scrollStyles, /align-content: start;/);
  assert.match(scrollStyles, /grid-auto-rows: max-content;/);
});

test('web app preview renders input and textarea as card-backed bordered fields', () => {
  const source = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');

  assert.match(source, /\.rivet-web-app-card,\s+\.rivet-web-app-field \{/);
  assert.match(
    source,
    /\.rivet-web-app-field input,\s+\.rivet-web-app-field textarea \{[\s\S]*border: 1px solid var\(--form-control-border\);/,
  );
  assert.match(
    source,
    /\.rivet-web-app-field input,\s+\.rivet-web-app-field textarea \{[\s\S]*background: var\(--form-control-bg\);/,
  );
  assert.match(source, /case 'input':[\s\S]*<label className="rivet-web-app-field">/);
  assert.match(source, /case 'textarea':[\s\S]*<label className="rivet-web-app-field">/);
});

test('web app renderer fills its parent so editor preview and preview windows own scrolling correctly', () => {
  const source = readFileSync(join(componentsDir, 'rivetWebApps', 'RivetWebAppRenderer.tsx'), 'utf8');
  const styles = source.match(/const styles = css`(?<styles>[\s\S]*?)`;/)?.groups?.styles;

  assert.ok(styles);
  assert.match(styles, /height: 100%;/);
  assert.doesNotMatch(styles, /height: 100vh;/);
  assert.match(styles, /overflow: auto;/);
});
