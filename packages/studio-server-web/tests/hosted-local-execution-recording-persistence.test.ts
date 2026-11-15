import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostedLocalExecutionRecordingPersistence } from '../dashboard/hostedLocalExecutionRecordingPersistence.js';
import { WORKFLOW_RECORDING_CREATED_AT_HEADER } from '../../studio-server-shared/workflow-recording-time.js';
import { hostedRecordingEvidenceHandle } from '../dashboard/hostedLocalExecutionRecordingPersistence.js';

const exampleInput = {
  projectId: 'project-1' as never,
  projectPath: '/workflows/example.rivet-project',
  projectContents: 'project',
  recordingSerialized: 'recording',
  status: 'failed' as const,
  durationMs: 12,
  executionIdentity: {
    correlationId: 'rvt-local-0f01eb95-2b7d-4fb4-8c77-9b50e3e4ce5c',
    graphId: 'graph-1',
  },
};

for (const status of [400, 409, 413]) {
  test(`a rejected upload (${status}) cannot be accepted using an older ready handoff`, async (t) => {
    let uploads = 0,
      reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (String(url).endsWith('/runs/read')) {
        reads++;
        return Response.json({ availability: 'pending', handoffReady: true });
      }
      uploads++;
      return Response.json({ error: 'The upload was rejected.' }, { status });
    });
    const provider = createHostedLocalExecutionRecordingPersistence();
    await assert.rejects(
      provider.persist({
        ...exampleInput,
        evidenceHandle: { id: 'fixture-run', token: 'fixture-token' },
      }),
      /upload was rejected/,
    );
    assert.equal(uploads, 1);
    assert.equal(reads, 0);
  });
}

for (const deleted of [false, true]) {
  test(`durable bridge reads uncertain writes back and ${deleted ? 'rejects deleted evidence' : 'retries only identical replay bytes'}`, async (t) => {
    let registration: { handle: { id: string; token: string }; correlationId: string } | undefined;
    const uploads: string[] = [];
    let registrations = 0;
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/capability')) return Response.json({ supported: true, durability: 'run-evidence-v1' });
      if (path.endsWith('/runs/begin')) {
        registrations++;
        registration = JSON.parse(String(init?.body));
        throw new Error('Registration acknowledgement lost');
      }
      if (path.endsWith('/runs/read'))
        return Response.json({
          id: registration!.handle.id,
          availability: uploads.length && deleted ? 'deleted' : 'pending',
          handoffReady: deleted,
        });
      if (path.endsWith('/runs/outcome')) return Response.json({ state: 'failed' });
      if (path.endsWith('/outcome')) return new Response(null, { status: 204 });
      uploads.push(String(init?.body));
      if (uploads.length === 1) throw new Error('Upload acknowledgement lost');
      return Response.json({ availability: 'available', recordingId: registration!.handle.id });
    });
    const provider = createHostedLocalExecutionRecordingPersistence();
    await provider.getCapability();
    const accepted = await provider.begin!({
      ...exampleInput,
      graphId: 'graph-1',
      correlationId: exampleInput.executionIdentity.correlationId,
      source: 'node',
    });
    assert.ok(accepted);
    try {
      await provider.complete!(accepted.correlationId, 'failed', 12);
      const input = {
        ...exampleInput,
        executionIdentity: { ...exampleInput.executionIdentity, correlationId: accepted.correlationId },
      };
      if (deleted) await assert.rejects(provider.persist(input), /acknowledgement/);
      else await provider.persist(input);
      assert.equal(registrations, 1);
      assert.equal(uploads.length, deleted ? 1 : 2);
      assert.equal(new Set(uploads).size, 1);
      assert.equal(hostedRecordingEvidenceHandle(accepted.correlationId), undefined);
    } finally {
      await provider.markUnavailable(accepted.correlationId);
    }
  });
}

test('start time is sent as optional upload metadata without changing older APIs strict JSON body', async (t) => {
  const createdAt = '2026-10-19T10:00:00.000Z';
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(init);
    assert.deepEqual(JSON.parse(String(init.body)), exampleInput);
    return Response.json({ availability: 'available' });
  });
  const provider = createHostedLocalExecutionRecordingPersistence();
  await provider.persist({ ...exampleInput, createdAt });
  await provider.persist(exampleInput);
  assert.equal(new Headers(requests[0]!.headers).get(WORKFLOW_RECORDING_CREATED_AT_HEADER), createdAt);
  assert.equal(new Headers(requests[1]!.headers).has(WORKFLOW_RECORDING_CREATED_AT_HEADER), false);
});

for (const [label, firstResponse] of [
  ['authentication failure', () => new Response(null, { status: 401 })],
  ['throttling', () => new Response(null, { status: 429 })],
  ['invalid JSON', () => new Response('invalid JSON', { headers: { 'Content-Type': 'application/json' } })],
  ['missing capability', () => Response.json({})],
] as const) {
  test(`hosted local recording bridge retries capability after ${label}`, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => (++calls === 1 ? firstResponse() : Response.json({ supported: true }));
    try {
      const provider = createHostedLocalExecutionRecordingPersistence();
      await assert.rejects(provider.getCapability(), /could not be confirmed/);
      assert.equal(await provider.getCapability(), true);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('local recording requests have bounded lifetimes and a timed-out capability can retry', async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  let calls = 0;
  // Exercise actual signal rejection without spending ten seconds in a unit test.
  AbortSignal.timeout = (milliseconds) => {
    timeouts.push(milliseconds);
    return originalTimeout(5);
  };
  const keepAlive = setTimeout(() => undefined, 1_000);
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal);
    if (++calls === 1) {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    }
    return Response.json({ supported: true, availability: 'available', recordingId: 'recording-1' });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    await assert.rejects(provider.getCapability(), /could not be confirmed/);
    assert.equal(await provider.getCapability(), true);
    await provider.persist(exampleInput);
    await provider.markUnavailable(exampleInput.executionIdentity.correlationId);
    assert.deepEqual(timeouts, [10_000, 10_000, 60_000, 10_000]);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});

test('hosted local recording bridge downgrades cleanly when an older API lacks capability', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    assert.equal(await provider.getCapability(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted local recording bridge retries capability after a transient failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error('Temporary network failure');
    return Response.json({ supported: true });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    await assert.rejects(provider.getCapability(), /could not be confirmed/);
    assert.equal(await provider.getCapability(), true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test('hosted local recording bridge retries capability after a transient server failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ supported: true });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    await assert.rejects(provider.getCapability(), /could not be confirmed/);
    assert.equal(await provider.getCapability(), true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted local recording bridge persists an ordinary successful replay through the authenticated API route', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith('/capability')) return Response.json({ supported: true });
    return Response.json({ availability: 'available', recordingId: 'recording-1' }, { status: 201 });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    assert.equal(await provider.getCapability(), true);
    const successfulRun = { ...exampleInput, status: 'succeeded' as const };
    await provider.persist(successfulRun);
    assert.equal(requests[1]?.url.endsWith('/workflows/local-editor-recordings'), true);
    assert.equal(requests[1]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), successfulRun);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted local recording bridge returns an upload error so the capturing executor can resolve pending health evidence', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith('/capability')) return Response.json({ supported: true });
    if (String(input).endsWith('/outcome')) return new Response(null, { status: 204 });
    return Response.json({ error: 'Cannot persist' }, { status: 500 });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    await assert.rejects(provider.persist(exampleInput), /Cannot persist/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url.endsWith('/workflows/local-editor-recordings'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted local recording bridge can resolve an unavailable socket recording without an upload', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  };
  try {
    const provider = createHostedLocalExecutionRecordingPersistence();
    await provider.markUnavailable(exampleInput.executionIdentity.correlationId);
    assert.equal(requests[0]?.url.endsWith('/workflows/local-editor-recordings/outcome'), true);
    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      correlationId: exampleInput.executionIdentity.correlationId,
      availability: 'persistence-failed',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
