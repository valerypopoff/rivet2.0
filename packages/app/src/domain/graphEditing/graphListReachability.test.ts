import assert from 'node:assert/strict';
import test from 'node:test';
import { type GraphId } from '@valerypopoff/rivet2-core';
import { buildGraphListReachabilityPresentation } from './graphListReachability.js';
import { type GraphReachabilityReport } from '../../utils/graphReachability.js';

function makeReport(
  overrides: Partial<GraphReachabilityReport> = {},
  buckets: {
    definite?: string[];
    dynamic?: string[];
    unreachable?: string[];
  } = {},
): GraphReachabilityReport {
  return {
    status: 'ready',
    blockedReason: undefined,
    definite: new Set((buckets.definite ?? []).map((graphId) => graphId as GraphId)),
    dynamic: new Set((buckets.dynamic ?? []).map((graphId) => graphId as GraphId)),
    unreachable: new Set((buckets.unreachable ?? []).map((graphId) => graphId as GraphId)),
    unsupportedNodeTypes: [],
    unsupportedReasons: [],
    warnings: [],
    ...overrides,
  };
}

test('ready report shows indicators and no notice', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport({}, { definite: ['main'], dynamic: ['maybe'], unreachable: ['spare'] }),
    graphIds: ['main', 'maybe', 'spare'] as GraphId[],
    plugins: [],
  });

  assert.equal(presentation.showUnreachableIndicators, true);
  assert.equal(presentation.notice, undefined);
  assert.deepEqual(presentation.bucketByGraphId, {
    main: 'definitely-reachable',
    maybe: 'dynamically-reachable',
    spare: 'unreachable',
  });
});

test('blocked report hides indicators and stays silent when no main graph is set', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport({ status: 'blocked', blockedReason: 'missing-main-graph' }, { unreachable: ['main'] }),
    graphIds: ['main'] as GraphId[],
    plugins: [],
  });

  assert.equal(presentation.showUnreachableIndicators, false);
  assert.equal(presentation.notice, undefined);
  assert.equal(presentation.bucketByGraphId['main' as GraphId], 'unreachable');
});

test('blocked report shows the main-graph notice when the configured main graph is invalid', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport({ status: 'blocked', blockedReason: 'invalid-main-graph' }, { unreachable: ['main'] }),
    graphIds: ['main'] as GraphId[],
    plugins: [],
  });

  assert.equal(presentation.showUnreachableIndicators, false);
  assert.equal(presentation.notice, 'Set a valid Main Graph in Project settings to see unreachable graphs.');
  assert.equal(presentation.bucketByGraphId['main' as GraphId], 'unreachable');
});

test('partial report shows indicators and the third-party warning', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport(
      {
        status: 'partial',
        unsupportedNodeTypes: ['customPluginNode'],
        unsupportedReasons: ['third-party-plugin-node'],
      },
      { definite: ['main'], unreachable: ['spare'] },
    ),
    graphIds: ['main', 'spare'] as GraphId[],
    plugins: [{ loaded: true, error: undefined }],
  });

  assert.equal(presentation.showUnreachableIndicators, true);
  assert.equal(presentation.notice, 'Unreachable graph analysis may be incomplete for third-party plugin nodes.');
  assert.equal(presentation.bucketByGraphId['spare' as GraphId], 'unreachable');
});

test('partial report uses the unsupported-node notice for unregistered node types', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport(
      {
        status: 'partial',
        unsupportedNodeTypes: ['missingNodeType'],
        unsupportedReasons: ['unregistered-node-type'],
      },
      { definite: ['main'], unreachable: ['spare'] },
    ),
    graphIds: ['main', 'spare'] as GraphId[],
    plugins: [{ loaded: true, error: undefined }],
  });

  assert.equal(presentation.showUnreachableIndicators, true);
  assert.equal(presentation.notice, 'Unreachable graph analysis may be incomplete for unsupported node types.');
});

test('plugin loading hides indicators and shows the loading notice', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport({}, { definite: ['main'], unreachable: ['spare'] }),
    graphIds: ['main', 'spare'] as GraphId[],
    plugins: [{ loaded: false, error: undefined }],
  });

  assert.equal(presentation.showUnreachableIndicators, false);
  assert.equal(presentation.notice, 'Unreachable graph analysis is waiting for app plugins to load.');
});

test('plugin load failures do not suppress indicators by themselves', () => {
  const presentation = buildGraphListReachabilityPresentation({
    report: makeReport(
      {
        status: 'partial',
        unsupportedNodeTypes: ['failedPluginNode'],
        unsupportedReasons: ['unregistered-node-type'],
      },
      { definite: ['main'], unreachable: ['spare'] },
    ),
    graphIds: ['main', 'spare'] as GraphId[],
    plugins: [{ loaded: false, error: 'boom' }],
  });

  assert.equal(presentation.showUnreachableIndicators, true);
  assert.equal(presentation.notice, 'Unreachable graph analysis may be incomplete for unsupported node types.');
});
