import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphId, ProjectId } from '@valerypopoff/rivet2-core';
import { GRAPH_BUILDER_PROTOCOL_VERSION } from '../../domain/graphBuilder/index.js';
import type { GraphBuilderBaseIdentity } from './identity.js';
import { revalidateLegacyGraphBuilderStartup } from './legacySessionStartup.js';

function baseIdentity(projectFingerprint = 'project'): GraphBuilderBaseIdentity {
  return {
    projectId: 'project' as ProjectId,
    activeGraphId: 'graph' as GraphId,
    editorRevision: 1,
    projectFingerprint,
    projectCanonicalIdentity: `canonical:${projectFingerprint}`,
    registryContractFingerprint: 'registry',
    registryContractCanonicalIdentity: 'canonical:registry',
    referencedProjectsFingerprint: 'references',
    referencedProjectsCanonicalIdentity: 'canonical:references',
    policyConfigFingerprint: 'policy',
    validationRulesVersion: '1',
    protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
  };
}

test('legacy startup abandons canceled or unmounted sessions before recapturing editor state', () => {
  let captureCount = 0;
  const captureContext = () => {
    captureCount += 1;
    return { base: baseIdentity(), eligibility: { eligible: true as const } };
  };
  const aborted = new AbortController();
  aborted.abort();

  assert.deepEqual(
    revalidateLegacyGraphBuilderStartup({
      abortSignal: aborted.signal,
      base: baseIdentity(),
      captureContext,
      isCurrent: true,
      isMounted: true,
    }),
    { status: 'abandoned' },
  );
  assert.deepEqual(
    revalidateLegacyGraphBuilderStartup({
      abortSignal: new AbortController().signal,
      base: baseIdentity(),
      captureContext,
      isCurrent: false,
      isMounted: true,
    }),
    { status: 'abandoned' },
  );
  assert.deepEqual(
    revalidateLegacyGraphBuilderStartup({
      abortSignal: new AbortController().signal,
      base: baseIdentity(),
      captureContext,
      isCurrent: true,
      isMounted: false,
    }),
    { status: 'abandoned' },
  );
  assert.equal(captureCount, 0);
});

test('legacy startup rejects editor identity drift after settings resolution', () => {
  assert.deepEqual(
    revalidateLegacyGraphBuilderStartup({
      abortSignal: new AbortController().signal,
      base: baseIdentity(),
      captureContext: () => ({
        base: baseIdentity('changed'),
        eligibility: { eligible: true },
      }),
      isCurrent: true,
      isMounted: true,
    }),
    { status: 'conflicted', currentFingerprint: 'changed' },
  );
  assert.deepEqual(
    revalidateLegacyGraphBuilderStartup({
      abortSignal: new AbortController().signal,
      base: baseIdentity(),
      captureContext: () => ({
        base: baseIdentity(),
        eligibility: { eligible: true },
      }),
      isCurrent: true,
      isMounted: true,
    }),
    { status: 'ready' },
  );
});
