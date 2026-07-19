import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConditionallyRenderWire } from './Wire.js';

function node(id: string, x: number): ChartNode {
  return {
    id: id as NodeId,
    type: id === 'llm' ? 'llmChatV2' : 'delegateFunctionCall',
    title: id,
    data: {},
    visualData: { x, y: 0 },
  };
}

function renderConnectedToolContinuationWire() {
  const llm = node('llm', 0);
  const delegate = node('delegate', 300);
  const connection: NodeConnection = {
    inputId: 'function-call' as PortId,
    inputNodeId: delegate.id,
    outputId: 'function-calls' as PortId,
    outputNodeId: llm.id,
  };

  return renderToStaticMarkup(
    createElement(
      'svg',
      undefined,
      createElement(ConditionallyRenderWire, {
        connection,
        highlighted: false,
        isNotRan: false,
        nodesById: { [llm.id]: llm, [delegate.id]: delegate },
        portPositions: {},
        selected: false,
        toolContinuation: {
          active: false,
          kind: 'connected',
          markerId: 'tool-continuation-marker',
          title: 'Tool continuation',
        },
      }),
    ),
  );
}

test('ConditionallyRenderWire renders a connected tool continuation as two thin visual lanes', () => {
  const html = renderConnectedToolContinuationWire();

  assert.equal((html.match(/tool-continuation-paired/g) ?? []).length, 2);
  assert.equal((html.match(/marker-end="url\(#tool-continuation-marker\)"/g) ?? []).length, 1);
  assert.equal((html.match(/marker-start="url\(#tool-continuation-marker\)"/g) ?? []).length, 1);
});
