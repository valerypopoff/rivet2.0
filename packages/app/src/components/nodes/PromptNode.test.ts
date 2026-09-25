import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PromptNodeImpl } from '@valerypopoff/rivet2-core';

// The component renders Monaco's colorized preview; only its browser worker
// needs a stub while checking the actual Prompt body markup on the server.
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
const { promptNodeDescriptor } = await import('./PromptNode.js').finally(() => hooks.deregister());

function renderPromptBody(t: TestContext, promptText: string): string {
  t.mock.method(console, 'error', (message: unknown) => {
    assert.match(String(message), /useLayoutEffect does nothing on the server/);
  });
  const Body = promptNodeDescriptor.Body;
  assert.ok(Body);
  const node = PromptNodeImpl.create();
  node.data.promptText = promptText;
  return renderToStaticMarkup(createElement(Body, { node }));
}

test('Prompt body keeps the compact role and colorizes Markdown with Text styling', (t) => {
  const html = renderPromptBody(t, '# Heading\n\nUse **bold**, `code`, and {{name}}.');

  assert.match(html, /class="prompt-node-role"><em>User<\/em><\/div>/);
  assert.match(html, /class="prompt-node-text"><pre class="node-body-colorized-wrap/);
  assert.match(html, /data-lang="prompt-interpolation-markdown"/);
  assert.match(html, /# Heading\n\nUse \*\*bold\*\*, `code`, and \{\{name\}\}\./);
  assert.doesNotMatch(html, /<strong>|<h1>|prompt-node-variable/);
});

test('Prompt body escapes source text and bounds long previews', (t) => {
  const html = renderPromptBody(t, `<script>unsafe</script>\n${'long '.repeat(80)}\n${'hidden\n'.repeat(20)}`);

  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const preview = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1];
  assert.ok(preview);
  assert.equal((preview.match(/hidden/g) ?? []).length, 13);
  assert.match(html, /\.\.\./);
});
