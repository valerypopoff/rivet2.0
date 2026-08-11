import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeId, Project, ProjectId, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';
import {
  getLLMProfileHealthDetail,
  getLLMProfileHealthDisplayName,
  getLLMProfileHealthIdentityLabel,
  normalizeLLMProfileHealthEntries,
} from './llmProfileHealthPresentation.js';

const snapshot: RivetLLMProfileHealthSnapshot = {
  identity: {
    configurationFingerprint: 'config',
    key: 'health-key',
    model: 'fast-model',
    profileNodeId: 'profile-1' as NodeId,
    projectId: 'project-1' as ProjectId,
    provider: 'custom',
  },
  failureCount: 2,
  openUntil: 12_000,
  state: 'open',
  updatedAt: 10_000,
};

test('LLM profile health uses graph and node names when the profile still exists', () => {
  const project = {
    metadata: { id: 'project-1', title: 'Project' },
    graphs: {
      graph: {
        metadata: { id: 'graph', name: 'Primary' },
        nodes: [{ id: 'profile-1', title: 'Fast provider', type: 'llmProfile', data: {}, visualData: {} }],
        connections: [],
      },
    },
  } as unknown as Project;

  assert.equal(getLLMProfileHealthDisplayName(project, snapshot), 'Fast provider in Primary');
});

test('LLM profile health falls back to provider and model after the source node is removed', () => {
  const project = { metadata: { id: 'project-1', title: 'Project' }, graphs: {} } as unknown as Project;

  assert.equal(getLLMProfileHealthDisplayName(project, snapshot), 'custom/fast-model');
  assert.equal(getLLMProfileHealthIdentityLabel(snapshot), 'Custom Completions/fast-model');
  assert.match(getLLMProfileHealthDetail(snapshot, 10_000), /^2 recent failures - suspended until /);
  assert.equal(getLLMProfileHealthDetail(snapshot, 12_000), '2 recent failures - recovery probe available');
});

test('LLM profile health ignores records outside the active project and sorts newest first', () => {
  const older = { ...snapshot, updatedAt: 8_000 };
  const newer = { ...snapshot, identity: { ...snapshot.identity, key: 'newer' }, updatedAt: 12_000 };
  const foreign = {
    ...snapshot,
    identity: { ...snapshot.identity, key: 'foreign', projectId: 'project-2' as ProjectId },
    updatedAt: 20_000,
  };

  assert.deepEqual(
    normalizeLLMProfileHealthEntries('project-1' as ProjectId, [older, foreign, newer]).map(
      (entry) => entry.identity.key,
    ),
    ['newer', 'health-key'],
  );
});

test('LLM profile health reports only an unexpired recovery lease as in progress', () => {
  const halfOpen = { ...snapshot, state: 'half-open' as const, halfOpenLeaseUntil: 11_000, openUntil: 9_000 };

  assert.equal(getLLMProfileHealthDetail(halfOpen, 10_000), '2 recent failures - recovery probe in progress');
  assert.equal(getLLMProfileHealthDetail(halfOpen, 12_000), '2 recent failures - recovery probe available');
});
