import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GRAPH_BUILDER_PROTOCOL_VERSION } from '../domain/graphBuilder/index.js';
import type { GraphBuilderSessionViewState } from '../features/graphBuilder/sessionController.js';
import { GraphBuilderSessionPanel } from './GraphBuilderSessionPanel.js';

const sessionId = 'session';

test('preview renders exact delta totals instead of bounded detail-array lengths', () => {
  const state: GraphBuilderSessionViewState = {
    status: 'ready-for-preview',
    sessionId,
    preview: {
      delta: {
        graphDeltas: [
          {
            graphId: 'graph',
            addedNodeCount: 100,
            removedNodeCount: 0,
            updatedNodeCount: 0,
            addedConnectionCount: 99,
            removedConnectionCount: 0,
            truncated: true,
            addedNodes: [{ nodeId: 'node', type: 'text', title: 'Text' }],
            removedNodes: [],
            updatedNodes: [],
            addedConnections: [],
            removedConnections: [],
          },
        ],
      },
      diagnostics: [],
      draftRevision: 1,
      summary: 'Prepared a large graph.',
    },
  };

  const html = renderToStaticMarkup(
    <GraphBuilderSessionPanel clarificationAnswer="" onClarificationAnswerChange={() => undefined} state={state} />,
  );

  assert.match(html, />1 graph changed</);
  assert.match(html, />100 nodes added</);
  assert.match(html, />99 connections added</);
  assert.match(html, /Detailed change lists are truncated/);
  assert.match(html, /Added nodes/);
  assert.match(html, /Text/);
  assert.match(html, /\(text\)/);
  assert.doesNotMatch(html, />1 nodes added</);
});

test('conflicted sessions retain the deterministic semantic delta instead of only the model summary', () => {
  const state: GraphBuilderSessionViewState = {
    status: 'conflicted',
    sessionId,
    result: {
      status: 'conflicted',
      base: {
        projectId: 'project',
        activeGraphId: 'graph',
        editorRevision: 1,
        projectFingerprint: 'project-fingerprint',
        registryContractFingerprint: 'registry-fingerprint',
        referencedProjectsFingerprint: 'references-fingerprint',
        policyConfigFingerprint: 'policy-fingerprint',
        validationRulesVersion: '1',
        protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
      },
      currentFingerprint: 'changed',
    },
    retainedPreview: {
      delta: {
        graphDeltas: [
          {
            graphId: 'graph',
            addedNodes: [],
            removedNodes: [],
            updatedNodes: [
              {
                nodeId: 'node',
                type: 'text',
                title: 'Prompt',
                changedFields: ['data.text', 'title'],
              },
            ],
            addedConnections: [
              {
                outputNodeId: 'source',
                outputId: 'output',
                inputNodeId: 'node',
                inputId: 'input',
              },
            ],
            removedConnections: [],
          },
        ],
      },
      diagnostics: [],
      draftRevision: 2,
      summary: 'Updated the prompt.',
    },
  };

  const html = renderToStaticMarkup(
    <GraphBuilderSessionPanel clarificationAnswer="" onClarificationAnswerChange={() => undefined} state={state} />,
  );

  assert.match(html, /Retained private-draft preview/);
  assert.match(html, /Updated nodes/);
  assert.match(html, /data.text, title/);
  assert.match(html, /Added connections/);
  assert.match(html, /source \/ output/);
  assert.match(html, /node \/ input/);
});

test('terminal budget and validation diagnostics remain visible', () => {
  const state: GraphBuilderSessionViewState = {
    status: 'budget-exhausted',
    sessionId,
    result: {
      status: 'budget-exhausted',
      diagnostics: [
        {
          diagnosticKey: 'missing-input',
          ruleId: 'missing-input',
          rulesVersion: '1',
          severity: 'error',
          verification: 'verified',
          message: 'A required input is not connected.',
          graphId: 'graph',
        },
      ],
    },
  };

  const html = renderToStaticMarkup(
    <GraphBuilderSessionPanel clarificationAnswer="" onClarificationAnswerChange={() => undefined} state={state} />,
  );

  assert.match(html, /Graph Builder budget exhausted/);
  assert.match(html, /A required input is not connected/);
  assert.match(html, /graph-builder-session-diagnostic-error/);
});
