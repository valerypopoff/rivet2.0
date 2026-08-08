import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, PortId } from '@valerypopoff/rivet2-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConditionallyRenderWire, ToolContinuationEndpointMarkers } from './Wire.js';

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

function renderConnectedToolContinuationEndpointMarkers() {
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
      createElement(ToolContinuationEndpointMarkers, {
        connection,
        markerId: 'tool-continuation-marker',
        nodesById: { [llm.id]: llm, [delegate.id]: delegate },
        portPositions: {},
      }),
    ),
  );
}

test('ConditionallyRenderWire renders a connected tool continuation as two thin visual lanes', () => {
  const html = renderConnectedToolContinuationWire();

  assert.equal((html.match(/tool-continuation-paired/g) ?? []).length, 2);
  assert.doesNotMatch(html, /tool-continuation-endpoint-marker-path/);
  assert.doesNotMatch(html, /marker-end=/);
  assert.doesNotMatch(html, /marker-start=/);
});

test('ToolContinuationEndpointMarkers renders a directional arrow at each lane endpoint', () => {
  const html = renderConnectedToolContinuationEndpointMarkers();

  assert.equal((html.match(/tool-continuation-endpoint-marker-path/g) ?? []).length, 2);
  assert.equal((html.match(/marker-end="url\(#tool-continuation-marker\)"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /marker-start=/);
});
