import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type { Project, ProjectId, RivetLLMProfileHealthSnapshot } from '@valerypopoff/rivet2-core';

import {
  getLLMProfileHealthDisplayName,
  getLLMProfileHealthStatusDetail,
  getLLMProfileHealthStatusTone,
  getOperationalLLMProfileHealthEntries,
} from '../dashboard/llmProfileHealthPresentation';

function snapshot(
  key: string,
  projectId: string,
  state: RivetLLMProfileHealthSnapshot['state'],
): RivetLLMProfileHealthSnapshot {
  return {
    identity: {
      key,
      projectId: projectId as ProjectId,
      profileNodeId: 'profile-node' as never,
      provider: 'custom',
      model: 'model',
      customProviderApi: 'responses',
      configurationFingerprint: 'sha256:test',
    },
    state,
    failureCount: state === 'open' ? 2 : 0,
    ...(state === 'open' ? { openUntil: Date.now() + 60_000 } : {}),
    updatedAt: key === 'newer' ? 2 : 1,
  };
}

test('LLM profile suspension settings show suspensions and recovery states in the active project', () => {
  const entries = getOperationalLLMProfileHealthEntries('project-a' as ProjectId, [
    snapshot('closed', 'project-a', 'closed'),
    snapshot('other-project', 'project-b', 'open'),
    snapshot('half-open', 'project-a', 'half-open'),
    snapshot('older', 'project-a', 'open'),
    snapshot('newer', 'project-a', 'open'),
  ]);

  assert.deepEqual(entries.map((entry) => entry.identity.key), ['newer', 'half-open', 'older']);
});

test('LLM profile suspension settings retain expired suspensions as awaiting recovery', () => {
  const entries = getOperationalLLMProfileHealthEntries('project-a' as ProjectId, [
    { ...snapshot('expired', 'project-a', 'open'), openUntil: 9_999 },
    { ...snapshot('active', 'project-a', 'open'), openUntil: 10_001 },
  ]);

  assert.deepEqual(entries.map((entry) => entry.identity.key), ['expired', 'active']);
  assert.match(getLLMProfileHealthStatusDetail(entries[0]!, 10_000), /awaiting recovery attempt/);
  assert.match(getLLMProfileHealthStatusDetail(entries[1]!, 10_000), /suspended until/);
  assert.equal(getLLMProfileHealthStatusTone(entries[0]!, 10_000), 'recovery');
  assert.equal(getLLMProfileHealthStatusTone(entries[1]!, 10_000), 'suspended');
});

test('LLM profile suspension settings distinguish an active recovery attempt', () => {
  const recovering = {
    ...snapshot('recovering', 'project-a', 'half-open'),
    halfOpenLeaseUntil: 10_001,
  };

  assert.match(getLLMProfileHealthStatusDetail(recovering, 10_000), /recovery attempt in progress/);
  assert.equal(getLLMProfileHealthStatusTone(recovering, 10_000), 'recovery');
});

test('LLM profile suspension settings resolve retained profile nodes to friendly graph and node names', () => {
  const project = {
    graphs: {
      graph: {
        metadata: { name: 'Chat' },
        nodes: [{ id: 'profile-node', title: 'Fast provider' }],
      },
    },
  } as unknown as Project;

  assert.equal(getLLMProfileHealthDisplayName(project, snapshot('open', 'project-a', 'open')), 'Fast provider in Chat');
  assert.equal(getLLMProfileHealthDisplayName(undefined, snapshot('open', 'project-a', 'open')), 'LLM Profile profile-node');
});

test('outer Project Settings owns LLM profile suspension administration and the embedded editor owns execution only', () => {
  const modalSource = readFileSync(new URL('../dashboard/ProjectSettingsModal.tsx', import.meta.url), 'utf8');
  const healthSource = readFileSync(new URL('../dashboard/LLMProfileHealthSettings.tsx', import.meta.url), 'utf8');
  const providersSource = readFileSync(new URL('../dashboard/hostedRivetProviders.ts', import.meta.url), 'utf8');

  assert.ok(modalSource.indexOf('Endpoint') < modalSource.indexOf('Web apps'));
  assert.ok(modalSource.indexOf('Web apps') < modalSource.indexOf('LLM profile suspension'));
  assert.match(healthSource, /HEALTH_REFRESH_INTERVAL_MS = 5_000/);
  assert.match(healthSource, /activeProject\.projectMetadataId/);
  assert.match(healthSource, /project\.metadata\.id/);
  assert.doesNotMatch(healthSource, /activeProject\.id as ProjectId/);
  assert.match(healthSource, /No LLM profiles are currently suspended or awaiting recovery\./);
  assert.match(healthSource, /project-settings-llm-health-row-\$\{tone\}/);
  assert.match(healthSource, /project-settings-llm-health-metadata-\$\{tone\}/);
  assert.doesNotMatch(healthSource, /LLM profile reliability/);
  assert.doesNotMatch(providersSource, /llmProfileHealthAdmin:/);
  assert.match(providersSource, /llmProfileHealthStore:/);
});
