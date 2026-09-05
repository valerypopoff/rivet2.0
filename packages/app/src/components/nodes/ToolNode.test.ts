import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const toolNodeSource = readFileSync(new URL('./ToolNode.tsx', import.meta.url), 'utf8');
const useNodeTypesSource = readFileSync(new URL('../../hooks/useNodeTypes.ts', import.meta.url), 'utf8');

test('Tool node body keeps the LLM-style Name field and Text-node colorizer separate', () => {
  assert.match(toolNodeSource, /getToolNodeBodyPreview/);
  assert.match(toolNodeSource, /tool-node-body-name-label">Name:<\/span>/);
  assert.match(toolNodeSource, /border-top: 1px solid color-mix\(in srgb, var\(--foreground\) 12%, transparent\);/);
  assert.match(toolNodeSource, /font-family: var\(--font-family-monospace\);/);
  assert.match(toolNodeSource, /\.tool-node-body-description \.node-body-colorized-wrap/);
  assert.match(toolNodeSource, /<ColorizedNodeBody[\s\S]*?language="prompt-interpolation-markdown"/);
  assert.doesNotMatch(toolNodeSource, /MarkdownNodeBody/);
});

test('Tool node descriptor is registered for custom canvas body rendering', () => {
  assert.match(useNodeTypesSource, /import \{ toolNodeDescriptor \} from '\.\.\/components\/nodes\/ToolNode\.js';/);
  assert.match(useNodeTypesSource, /gptFunction: toolNodeDescriptor,/);
});
