import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { LLMChatV2NodeImpl, type LLMChatV2Node, type NodeId } from '@valerypopoff/rivet2-core';
import { renderMarkdown } from '../hooks/useMarkdown.js';

Object.defineProperty(globalThis, 'window', { configurable: true, value: new JSDOM('').window });

function createLLMChatNode(data: Partial<LLMChatV2Node['data']> = {}) {
  const node = LLMChatV2NodeImpl.create();

  return new LLMChatV2NodeImpl({
    ...node,
    id: 'llm-chat-body-preview' as NodeId,
    data: {
      ...node.data,
      ...data,
    },
  });
}

test('LLM Chat custom provider base URL renders as plain body text instead of a markdown link', async () => {
  const body = createLLMChatNode({
    provider: 'custom',
    customProviderBaseURL: 'https://api.cerebras.ai/v1',
  }).getBody();

  assert.equal(typeof body, 'object');
  assert.ok(body != null);
  assert.equal(Array.isArray(body), false);
  assert.equal(body.type, 'markdown');

  const html = renderMarkdown(body.text, true, { disableLinks: body.disableLinks });

  assert.doesNotMatch(html, /<a\b/i);
  assert.match(html, /https:\/\/api\.cerebras\.ai\/v1/);
});
