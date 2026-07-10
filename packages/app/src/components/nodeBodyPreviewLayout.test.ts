import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('node body previews distinguish wrapped text from clipped object source', () => {
  const nodeBodySource = readFileSync(join(componentsDir, 'NodeBody.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const objectNodeSource = readFileSync(join(componentsDir, 'nodes', 'ObjectNode.tsx'), 'utf8');
  const colorizedWrapBlock = /\.node-body-colorized-wrap \{(?<styles>[\s\S]*?)\n  \}/.exec(nodeBodySource)?.groups
    ?.styles;

  assert.match(nodeBodySource, /function shouldWrapColorizedNodeBody\(language: string\)/);
  assert.match(nodeBodySource, /language === 'prompt-interpolation-markdown'/);
  assert.ok(colorizedWrapBlock, 'Expected a dedicated CSS block for wrapped colorized node bodies');
  assert.match(colorizedWrapBlock, /max-width: 100%;/);
  assert.match(colorizedWrapBlock, /min-width: 0;/);
  assert.match(colorizedWrapBlock, /overflow-wrap: normal;/);
  assert.match(colorizedWrapBlock, /white-space: pre-wrap;/);
  assert.match(colorizedWrapBlock, /width: 100%;/);
  assert.match(colorizedWrapBlock, /word-break: normal;/);
  assert.doesNotMatch(colorizedWrapBlock, /overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(colorizedWrapBlock, /word-break:\s*break-word;/);
  assert.match(nodeBodySource, /wrapWords=\{wrapWords\}/);
  assert.match(nodeBodySource, /renderedSpecs\.length === 0 && \(!pending \|\| height == null\)/);
  assert.match(nodeStylesSource, /\.node-body:empty \{[\s\S]*margin-bottom: 0;[\s\S]*\}/);
  assert.match(objectNodeSource, /text-overflow: clip;/);
  assert.doesNotMatch(objectNodeSource, /text-overflow: ellipsis;/);
});

test('wrapped colorized node bodies normalize Monaco non-breaking spaces', () => {
  const colorizedSource = readFileSync(join(componentsDir, 'ColorizedPreformattedText.tsx'), 'utf8');

  assert.match(colorizedSource, /function normalizeColorizedWordWrapSpaces\(element: HTMLElement\)/);
  assert.match(colorizedSource, /replace\(\/\\u00A0\/g, ' '\)/);
  assert.match(colorizedSource, /if \(wrapWords\) \{/);
  assert.match(colorizedSource, /normalizeColorizedWordWrapSpaces\(body\)/);
});

test('colorized previews inline Monaco token colors before guarded writes', () => {
  const colorizedSource = readFileSync(join(componentsDir, 'ColorizedPreformattedText.tsx'), 'utf8');
  const monacoSource = readFileSync(join(componentsDir, '..', 'utils', 'monaco.ts'), 'utf8');

  assert.match(colorizedSource, /ensureMonacoLanguage\(language\)/);
  assert.match(colorizedSource, /function inlineMonacoTokenStyles\(element: HTMLElement\)/);
  assert.match(colorizedSource, /querySelectorAll<HTMLElement>\('span\[class\*="mtk"\]'\)/);
  assert.match(colorizedSource, /token\.style\.color = style\.color/);
  assert.match(colorizedSource, /token\.removeAttribute\('class'\)/);
  assert.match(colorizedSource, /async function colorizeStableHtml\(text: string, language: string, theme: string\)/);
  assert.match(colorizedSource, /scratchRoot\.appendChild\(colorizedBody\)/);
  assert.match(colorizedSource, /document\.body\.appendChild\(scratchRoot\)/);
  assert.match(colorizedSource, /colorizedBody\.dataset\.lang = language/);
  assert.match(colorizedSource, /monaco\.editor\.colorizeElement\(colorizedBody, \{ theme \}\)/);
  assert.match(colorizedSource, /inlineMonacoTokenStyles\(colorizedBody\)/);
  assert.match(colorizedSource, /scratchRoot\.remove\(\)/);
  assert.match(colorizedSource, /colorizeStableHtml\(text, language, resolvedTheme\)/);
  assert.match(colorizedSource, /colorizeRequestRef\.current !== colorizeRequest/);
  assert.match(colorizedSource, /body\.innerHTML = html/);
  assert.doesNotMatch(colorizedSource, /monaco\.editor\.setTheme/);
  assert.match(monacoSource, /monaco-editor\/esm\/vs\/language\/json\/monaco\.contribution\.js/);
  assert.match(monacoSource, /monaco-editor\/esm\/vs\/language\/json\/jsonMode\.js/);
  assert.match(monacoSource, /monaco\.editor\.createModel\('', 'json'\)/);
  assert.match(monacoSource, /languageContributionPromises\.delete\(language\)/);
});
