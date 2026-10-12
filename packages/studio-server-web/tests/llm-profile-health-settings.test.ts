import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpLLMProfileHealthAdminProvider } from '../../studio-server-shared/llmProfileHealthHttpStore.js';

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

test('Classifier suspension administration scopes both list and reset to its family', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const provider = createHttpLLMProfileHealthAdminProvider({
    baseUrl: 'https://rivet.example/api/workflows/llm-profile-health',
    family: 'classifier',
    fetch: async (url, options) => {
      requests.push({ url: String(url), body: options?.body ? JSON.parse(String(options.body)) : null });
      return options?.method === 'POST' ? new Response(null, { status: 204 }) : Response.json([]);
    },
  });
  await provider.list({ projectId: 'project a' as never });
  await provider.reset({ projectId: 'project a' as never });
  assert.match(requests[0]!.url, /projectId=project%20a&family=classifier$/);
  assert.deepEqual(requests[1]!.body, { projectId: 'project a', family: 'classifier' });
});

test('LLM profile suspension settings show suspensions and recovery states in the active project', () => {
  const entries = getOperationalLLMProfileHealthEntries('project-a' as ProjectId, [
    snapshot('closed', 'project-a', 'closed'),
    snapshot('other-project', 'project-b', 'open'),
    snapshot('half-open', 'project-a', 'half-open'),
    snapshot('older', 'project-a', 'open'),
    snapshot('newer', 'project-a', 'open'),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.identity.key),
    ['newer', 'half-open', 'older'],
  );
});

test('LLM profile suspension settings retain expired suspensions as awaiting recovery', () => {
  const entries = getOperationalLLMProfileHealthEntries('project-a' as ProjectId, [
    { ...snapshot('expired', 'project-a', 'open'), openUntil: 9_999 },
    { ...snapshot('active', 'project-a', 'open'), openUntil: 10_001 },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.identity.key),
    ['expired', 'active'],
  );
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
  assert.equal(
    getLLMProfileHealthDisplayName(undefined, snapshot('open', 'project-a', 'open')),
    'LLM Profile profile-node',
  );
  const namedSnapshot = snapshot('named', 'project-a', 'open');
  assert.equal(
    getLLMProfileHealthDisplayName(undefined, {
      ...namedSnapshot,
      identity: { ...namedSnapshot.identity, profileName: 'Primary route' },
    }),
    'Primary route',
  );
});
