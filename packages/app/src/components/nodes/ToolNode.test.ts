import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GptFunctionNode } from '@valerypopoff/rivet2-core';

// Monaco needs a browser worker. Keep the real Tool and ColorizedNodeBody
// components, and stub only the browser editor while rendering their output.
const monacoUrl = new URL('../../utils/monaco.ts', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === monacoUrl
      ? {
          url: 'data:text/javascript,export const monaco = {}; export const ensureMonacoLanguage = async () => {};',
          shortCircuit: true,
        }
      : resolved;
  },
});
const { toolNodeDescriptor } = await import('./ToolNode.js').finally(() => hooks.deregister());

function renderToolBody(t: TestContext, name: string, description: string): string {
  // The static renderer intentionally does not run Monaco's layout effect.
  t.mock.method(console, 'error', (message: unknown) => {
    assert.match(String(message), /useLayoutEffect does nothing on the server/);
  });
  const Body = toolNodeDescriptor.Body;
  assert.ok(Body, 'Tool nodes must provide a custom canvas body');
  return renderToStaticMarkup(createElement(Body, { node: { data: { name, description } } as GptFunctionNode }));
}

test('Tool body renders a distinct Name field and a separated Text-style description', (t) => {
  const html = renderToolBody(t, 'getStory', 'Return `story_data`.\n\n- Keep **formatting** and {{variables}}.');

  assert.match(html, /class="tool-node-body-name-label">Name:<\/span> getStory/);
  assert.match(html, /\.tool-node-body-name-label\{opacity:0\.6;/);
  assert.match(html, /border-top:1px solid color-mix/);
  assert.match(html, /font-family:var\(--font-family-monospace\)/);
  assert.match(html, /class="tool-node-body-description"><pre class="node-body-colorized-wrap/);
  assert.match(html, /data-lang="prompt-interpolation-markdown"/);
  assert.match(html, /Return `story_data`\.\n\n- Keep \*\*formatting\*\* and \{\{variables\}\}\./);
  assert.doesNotMatch(html, /<strong>|<ul>/);
});

test('Tool body omits the description separator when the description is empty', (t) => {
  const html = renderToolBody(t, 'getStory', '');

  assert.match(html, />Name:<\/span> getStory/);
  assert.doesNotMatch(html, /class="tool-node-body-description"|<pre/);
});

test('Tool body escapes tool names and clips long descriptions before rendering', (t) => {
  const html = renderToolBody(t, '<script>name</script>', `${'Long description\n'.repeat(40)}hidden-tail`);

  assert.match(html, /&lt;script&gt;name&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|hidden-tail/);
  assert.match(html, /\.\.\./);
});
