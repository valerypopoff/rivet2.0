import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildManagedReleaseGateConfig,
  imageReference,
  renderManagedReleaseGateValues,
} from '../../../../deploy/studio-server/scripts/lib/kubernetes-managed-release-gate-config.mjs';
import { assertCandidateManifestImages } from '../../../../deploy/studio-server/scripts/lib/kubernetes-candidate-manifest-images.mjs';
import { buildManagedProviderGateConfig } from '../../../../deploy/studio-server/scripts/lib/kubernetes-managed-provider-gate-config.mjs';
import { summarizePodStartupState } from '../../../../deploy/studio-server/scripts/lib/kubernetes-workload-diagnostics.mjs';
import { assertRuntimeReadiness } from '../../../../deploy/studio-server/scripts/lib/kubernetes-runtime-readiness.mjs';

const rootDir = path.resolve(import.meta.dirname, '../../../..');
const { ManagedReleaseGate } = await import(
  pathToFileURL(path.join(rootDir, 'deploy/studio-server/scripts/kubernetes-managed-release-gate.mjs')).href
);
const { ManagedProviderGate } = await import(
  pathToFileURL(path.join(rootDir, 'deploy/studio-server/scripts/kubernetes-managed-provider-gate.mjs')).href
);
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;

const recoveredAppHtml =
  '<main data-rivet-web-app-config="{&quot;revisionKey&quot;:&quot;published-fixture&quot;}">Managed release gate app</main>';

function replacementGate() {
  const gate = new ManagedReleaseGate({}, 'unused-kubectl', 'unused-helm');
  const replacements: string[] = [];
  let workflowCalls = 0;
  gate.replaceWorkload = async (_baseUrl: string, component: string) => {
    replacements.push(component);
    return `${component}-replacement`;
  };
  gate.requestWorkflow = async () => {
    workflowCalls++;
    return { hostname: 'execution-replacement', environmentValue: 'managed-persistence' };
  };
  return { gate, replacements, workflowCalls: () => workflowCalls };
}

test('managed release gate CLI still runs and rejects missing context before touching a cluster', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'deploy/studio-server/scripts/kubernetes-managed-release-gate.mjs'), 'smoke'],
    {
      env: { ...process.env, RIVET_K8S_RELEASE_GATE_CONTEXT: '', RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: '' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, 'the CLI entrypoint must not become a silent successful no-op');
  assert.match(result.stderr, /RIVET_K8S_RELEASE_GATE_CONTEXT is required/);
});

test('replacement web-app probe recovers from Service connection failures without replaying an action', async (t) => {
  const { gate, replacements, workflowCalls } = replacementGate();
  let appCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, undefined, 'only read-only requests may be retried by the recovery probe');
    if (url.includes('/api/app-settings/')) return Response.json({ value: 'managed-persistence' });
    assert.equal(url, 'http://fixture/apps/release-gate-web-app');
    if (++appCalls === 1) throw new TypeError('fetch failed during endpoint turnover');
    if (appCalls === 2) return new Response('gateway failure', { status: 502 });
    if (appCalls === 3) return new Response('not ready', { status: 503 });
    return new Response(recoveredAppHtml);
  });
  await gate.verifyAfterReplacement('http://fixture', {
    environmentVariableId: 'saved-variable',
    publishedRevision: 'published-fixture',
  });
  assert.deepEqual(replacements, ['backend', 'execution']);
  assert.equal(workflowCalls(), 1);
  assert.equal(appCalls, 4);
});

for (const [label, response, failure] of [
  ['persistent gateway failure', () => new Response('bad gateway', { status: 502 }), /replacement: 502/],
  ['wrong app HTML', () => new Response('<main>Login page</main>'), /unexpected HTML/],
  [
    'wrong publication revision',
    () => new Response(recoveredAppHtml.replace('published-fixture', 'wrong-revision')),
    /did not retain its published revision/,
  ],
] as const) {
  test(`replacement web-app recovery remains bounded and rejects ${label}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const { gate, workflowCalls } = replacementGate();
    let appCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.includes('/api/app-settings/')) return Response.json({ value: 'managed-persistence' });
      appCalls++;
      return response();
    });
    const outcome = assert.rejects(
      gate.verifyAfterReplacement('http://fixture', {
        environmentVariableId: 'saved-variable',
        publishedRevision: 'published-fixture',
      }),
      (error: Error) => {
        assert.match(error.message, /Timed out waiting for published web-app recovery after execution replacement/);
        assert.match(error.message, failure);
        return true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(appCalls, 1);
    t.mock.timers.tick(90_000);
    await outcome;
    assert.equal(workflowCalls(), 1);
    assert.equal(appCalls, 1, 'no request may be sent after the recovery window expires');
  });
}

const readyHealth = { ok: true, state: 'ready', checks: [] };
const storageUnavailableHealth = {
  ok: false,
  state: 'ready',
  code: 'dependency_unavailable',
  checks: [{ ok: false, code: 'workflow_storage_unavailable' }],
};

for (const [label, body] of [
  ['frontend HTML containing ready', '<!doctype html><title>Ready to sign in</title>'],
  ['unready JSON containing ready', JSON.stringify({ ok: false, state: 'not-ready' })],
  ['restore warmup', JSON.stringify({ ...readyHealth, restoreMaintenance: true, restoreWarmup: true })],
  ['null JSON', 'null'],
] as const) {
  test(`all qualification gates reject ${label} without echoing the body`, () => {
    assert.throws(
      () => assertRuntimeReadiness({ status: 200, body }),
      (error: Error) => {
        assert.match(error.message, /\/readyz (returned non-JSON|did not report a ready runtime)/);
        assert.equal(error.message.includes(body), false);
        return true;
      },
    );
  });
  for (const gatewayMode of ['embedded', 'external']) {
    test(`${gatewayMode} provider gate stops surface probes after ${label}`, async (t) => {
      const gate = new ManagedProviderGate(
        { gatewayMode, baseUrl: 'https://fixture.test', requestHeaders: {} },
        'unused',
        'unused',
      );
      const requests: string[] = [];
      t.mock.method(globalThis, 'fetch', async (url: URL) => {
        requests.push(url.pathname);
        return new Response(body);
      });
      await assert.rejects(gate.assertPublicSurface(), /\/readyz/);
      assert.deepEqual(requests, ['/readyz']);
    });
  }
}

test('shared readiness rejects redirects and non-200 success without accepting a healthy body', () => {
  for (const status of [201, 204, 302, 401, 403, 503]) {
    assert.throws(
      () => assertRuntimeReadiness({ status, body: JSON.stringify(readyHealth) }),
      new RegExp(`HTTP ${status}`),
    );
  }
  assert.doesNotThrow(() => assertRuntimeReadiness({ status: 200, body: JSON.stringify(readyHealth) }));
});

test('provider gate still runs directly and rejects missing protected confirmation before cluster work', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(rootDir, 'deploy/studio-server/scripts/kubernetes-managed-provider-gate.mjs')],
    {
      env: { ...process.env, RIVET_K8S_PROVIDER_GATE_CONFIRM: '' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RIVET_K8S_PROVIDER_GATE_CONFIRM/);
});

for (const gatewayMode of ['embedded', 'external']) {
  test(`${gatewayMode} provider gate preserves published probes and external private-route fencing after healthy readiness`, async (t) => {
    const gate = new ManagedProviderGate(
      {
        gatewayMode,
        baseUrl: 'https://fixture.test',
        requestHeaders: { authorization: 'Bearer fixture-token' },
        workflowProbe: {
          path: '/workflows/fixture',
          method: 'POST',
          body: { input: 'fixture' },
          contains: 'published-workflow',
        },
        webAppProbe: { path: '/apps/fixture', contains: 'published-app' },
      },
      'unused',
      'unused',
    );
    const paths: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
      paths.push(url.pathname);
      assert.equal((init.headers as Record<string, string>).authorization, 'Bearer fixture-token');
      assert.equal(init.redirect, 'manual');
      if (url.pathname === '/readyz') return Response.json(readyHealth);
      if (url.pathname === '/apps/fixture') return new Response('<main>published-app</main>');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, JSON.stringify({ input: 'fixture' }));
      return url.pathname === '/workflows/fixture'
        ? new Response('published-workflow')
        : new Response('not found', { status: 404 });
    });
    await gate.assertPublicSurface();
    assert.deepEqual(paths, [
      '/readyz',
      '/workflows/fixture',
      '/apps/fixture',
      ...(gatewayMode === 'external' ? ['/internal/workflows/fixture'] : []),
    ]);
  });
}

for (const status of [302, 401, 403, 404, 500, 501]) {
  test(`provider interruption cannot be certified by HTTP ${status}, and restores its network policy`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const gate = new ManagedProviderGate(
      {
        namespace: 'fixture-owned',
        baseUrl: 'https://fixture.test',
        requestHeaders: {},
        interruptionManifests: [
          { name: 'fixture outage', applyFile: 'block.yaml', restoreFile: 'restore.yaml', restoreAction: 'apply' },
        ],
      },
      'unused',
      'unused',
    );
    const commands: string[][] = [];
    gate.validateInterruptionManifest = async () => {};
    gate.kubectl = async (args: string[]) => {
      commands.push(args);
    };
    const response = new Response('not an outage', { status });
    t.mock.method(globalThis, 'fetch', async () => response);
    const outcome = assert.rejects(
      gate.verifyDependencyInterruptions(),
      /timed out waiting for fixture outage readiness failure/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(response.bodyUsed, true);
    t.mock.timers.tick(90_000);
    await outcome;
    assert.deepEqual(commands, [
      ['apply', '--namespace', 'fixture-owned', '-f', 'block.yaml'],
      ['apply', '--namespace', 'fixture-owned', '-f', 'restore.yaml'],
    ]);
  });
}

for (const status of [502, 503, 504]) {
  test(`provider interruption consumes HTTP ${status} and revalidates recovery before surface probes`, async (t) => {
    const gate = new ManagedProviderGate(
      {
        namespace: 'fixture-owned',
        baseUrl: 'https://fixture.test',
        requestHeaders: {},
        interruptionManifests: [
          { name: 'fixture outage', applyFile: 'block.yaml', restoreFile: 'restore.yaml', restoreAction: 'apply' },
        ],
      },
      'unused',
      'unused',
    );
    const steps: string[] = [];
    gate.validateInterruptionManifest = async () => {};
    gate.kubectl = async (args: string[]) => {
      steps.push(args.at(-1)!);
    };
    gate.assertPublicHealth = async () => {
      steps.push('readiness');
    };
    gate.assertPublicSurface = async () => {
      steps.push('surfaces');
    };
    const response = new Response('temporarily unavailable', { status });
    t.mock.method(globalThis, 'fetch', async () => response);
    await gate.verifyDependencyInterruptions();
    assert.equal(response.bodyUsed, true);
    assert.deepEqual(steps, ['block.yaml', 'restore.yaml', 'readiness', 'surfaces']);
  });
}

test('a frontend HTML 200 cannot certify runtime readiness and reports the routing defect', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = new ManagedReleaseGate({}, 'unused', 'unused');
  const response = new Response('<!doctype html><title>Rivet editor</title>', {
    headers: { 'content-type': 'text/html' },
  });
  t.mock.method(globalThis, 'fetch', async () => response);
  const outcome = assert.rejects(
    gate.waitForReady('http://fixture', 'proxy readiness'),
    /Timed out waiting for proxy readiness: \/readyz returned non-JSON content \(HTTP 200\); check proxy health routing/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(response.bodyUsed, true);
  t.mock.timers.tick(90_000);
  await outcome;
});

test('outage diagnostics read the owned backend API directly even when Service routing is unavailable', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/readyz');
    assert.equal(
      req.headers['x-rivet-proxy-auth'],
      createHash('sha256').update('fixture-key:proxy-auth').digest('hex'),
    );
    assert.equal(
      req.headers.cookie,
      `rivet_ui_token=${createHash('sha256').update('fixture-key:ui-session').digest('hex')}`,
    );
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(storageUnavailableHealth));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const gate = new ManagedReleaseGate({ namespace: 'fixture-owned', release: 'fixture' }, 'unused', 'unused');
  gate.kubectl = async (args: string[], options: { capture: boolean }) => {
    assert.deepEqual(args.slice(0, 9), [
      'exec',
      '-n',
      'fixture-owned',
      'statefulset/fixture-backend',
      '-c',
      'backend',
      '--request-timeout=10s',
      '--pod-running-timeout=10s',
      '--',
    ]);
    assert.equal(args[9], 'node');
    assert.equal(options.capture, true);
    return promisify(execFile)(process.execPath, args.slice(10), {
      cwd: path.join(rootDir, 'packages/studio-server-api'),
      env: { ...process.env, RIVET_BACKEND_API_PORT: String(address.port), RIVET_KEY: 'fixture-key' },
      timeout: 10_000,
      windowsHide: true,
    });
  };
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Service has no ready endpoints');
  });
  try {
    const result = await gate.readBackendResponse('/readyz');
    assert.equal(result.status, 503);
    assert.deepEqual(JSON.parse(result.body), storageUnavailableHealth);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

function readyPod(name: string, uid: string, terminating = false) {
  return {
    metadata: { name, uid, ...(terminating ? { deletionTimestamp: '2026-10-13T00:00:00Z' } : {}) },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
}

for (const component of ['backend', 'execution']) {
  test(`${component} replacement requires a new UID, not an existing or terminating sibling`, async (t) => {
    const gate = new ManagedReleaseGate({ release: 'fixture', namespace: 'fixture-owned' }, 'unused', 'unused');
    const commands: string[][] = [];
    let lists = 0;
    gate.kubectl = async (args: string[]) => {
      commands.push(args);
      if (args[0] !== 'get') return { stdout: '' };
      lists++;
      return {
        stdout: JSON.stringify({
          items:
            lists === 1
              ? [
                  readyPod('terminating-old', 'terminating-old', true),
                  readyPod('original', 'old'),
                  readyPod('sibling', 'sibling'),
                ]
              : lists === 2
                ? [readyPod('sibling', 'sibling'), readyPod('terminating-new', 'new-terminating', true)]
                : [readyPod('sibling', 'sibling'), readyPod(component === 'backend' ? 'original' : 'new-pod', 'new')],
        }),
      };
    };
    let healthResponse: Response | undefined;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      assert.equal(url, 'http://fixture/readyz');
      healthResponse = Response.json(readyHealth);
      return healthResponse;
    });
    assert.equal(
      await gate.replaceWorkload('http://fixture', component),
      component === 'backend' ? 'original' : 'new-pod',
    );
    assert.equal(lists, 3);
    assert.deepEqual(
      commands.find((args) => args[0] === 'delete'),
      ['delete', 'pod', '-n', 'fixture-owned', 'original', '--wait=false'],
    );
    assert.equal(healthResponse?.bodyUsed, true);
  });
}

test('a workload with only terminating pods is not deleted again', async () => {
  const gate = new ManagedReleaseGate({ release: 'fixture', namespace: 'fixture-owned' }, 'unused', 'unused');
  let calls = 0;
  gate.kubectl = async () => {
    calls++;
    return { stdout: JSON.stringify({ items: [readyPod('terminating', 'old', true)] }) };
  };
  await assert.rejects(gate.replaceWorkload('http://fixture', 'execution'), /No execution pod was available/);
  assert.equal(calls, 1);
});

test('readiness recovery consumes responses and rejects a 200 maintenance or non-ready response', async (t) => {
  const gate = new ManagedReleaseGate({}, 'unused', 'unused');
  const responses = [
    new Response('bad gateway', { status: 502 }),
    Response.json({ ok: true, restoreMaintenance: true }),
    Response.json({ ...readyHealth, restoreMaintenance: true, restoreWarmup: true }),
    Response.json({ ok: true, state: 'starting' }),
    Response.json(readyHealth),
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[calls++]);
  await gate.waitForReady('http://fixture', 'test recovery');
  assert.equal(calls, 5);
  assert.ok(responses.every((response) => response.bodyUsed));
});

for (const [label, response] of [
  ['proxy error', () => new Response('bad gateway', { status: 502 })],
  ['authentication error', () => Response.json({ error: 'unauthorized' }, { status: 401 })],
  [
    'stale health check',
    () => Response.json({ ...storageUnavailableHealth, code: 'health_check_stale' }, { status: 503 }),
  ],
  [
    'unrelated failed dependency',
    () =>
      Response.json(
        { ...storageUnavailableHealth, checks: [{ ok: false, code: 'web_app_gateway_unavailable' }] },
        { status: 503 },
      ),
  ],
] as const) {
  test(`storage outage cannot be certified by ${label}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const gate = new ManagedReleaseGate({}, 'unused', 'unused');
    const actualResponse = response();
    gate.readBackendResponse = async (route: string) => {
      assert.equal(route, '/readyz');
      return { status: actualResponse.status, body: await actualResponse.text() };
    };
    const outcome = assert.rejects(
      gate.waitForStorageUnavailable('storage outage'),
      /Timed out waiting for storage outage/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(actualResponse.bodyUsed, true);
    t.mock.timers.tick(60_000);
    await outcome;
  });
}

function dependencyGate() {
  const gate = new ManagedReleaseGate({}, 'unused', 'unused');
  const replicas: Array<[string, number]> = [];
  let environmentChecks = 0;
  gate.setDependencyReplicas = async (component: string, count: number) => {
    replicas.push([component, count]);
  };
  gate.waitForDependency = async () => {};
  gate.readBackendResponse = async (route: string) => ({
    status: route === '/readyz' ? 503 : 500,
    body: route === '/readyz' ? JSON.stringify(storageUnavailableHealth) : 'storage unavailable',
  });
  gate.assertPersistedEnvironment = async () => {
    environmentChecks++;
  };
  return { gate, replicas, environmentChecks: () => environmentChecks };
}

const replayContents = 'retained fixture project';
const replayState = {
  replayRecordingId: 'retained-recording',
  replayProjectDigest: createHash('sha256').update(replayContents).digest('hex'),
};

test('dependency recovery restores both stores and verifies replay bytes after transient routing failure', async (t) => {
  const { gate, replicas, environmentChecks } = dependencyGate();
  const responses: Response[] = [];
  let replayCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(options.method, undefined);
    const [, count] = replicas.at(-1)!;
    const response = url.endsWith('/readyz')
      ? Response.json(count === 0 ? storageUnavailableHealth : readyHealth, { status: count === 0 ? 503 : 200 })
      : ++replayCalls === 1
        ? new Response('endpoint turnover', { status: 502 })
        : new Response(replayContents);
    responses.push(response);
    return response;
  });
  await gate.verifyManagedDependencyRecovery('http://fixture', replayState);
  assert.deepEqual(replicas, [
    ['minio', 0],
    ['minio', 1],
    ['postgres', 0],
    ['postgres', 1],
  ]);
  assert.equal(replayCalls, 2);
  assert.equal(environmentChecks(), 1);
  assert.ok(responses.every((response) => response.bodyUsed));
});

test('changed replay data cannot certify recovery and does not start another dependency outage', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const { gate, replicas, environmentChecks } = dependencyGate();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const down = replicas.at(-1)?.[1] === 0;
    if (url.endsWith('/readyz'))
      return Response.json(down ? storageUnavailableHealth : readyHealth, { status: down ? 503 : 200 });
    return new Response(down ? 'storage failure' : 'different project', { status: down ? 500 : 200 });
  });
  const outcome = assert.rejects(
    gate.verifyManagedDependencyRecovery('http://fixture', replayState),
    /Recovered recording replay project changed/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(90_000);
  await outcome;
  assert.deepEqual(replicas, [
    ['minio', 0],
    ['minio', 1],
  ]);
  assert.equal(environmentChecks(), 0);
});

test('a missing replay during an outage fails and still restores MinIO', async (t) => {
  const { gate, replicas } = dependencyGate();
  gate.readBackendResponse = async (route: string) =>
    route === '/readyz'
      ? { status: 503, body: JSON.stringify(storageUnavailableHealth) }
      : { status: 404, body: 'not found' };
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('outage classification must not depend on Service routing');
  });
  await assert.rejects(
    gate.verifyManagedDependencyRecovery('http://fixture', replayState),
    /replay storage failure: 404/,
  );
  assert.deepEqual(replicas, [
    ['minio', 0],
    ['minio', 1],
  ]);
});

test('a failed PostgreSQL outage assertion still restores PostgreSQL', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const { gate, replicas, environmentChecks } = dependencyGate();
  gate.readBackendResponse = async (route: string) => {
    if (replicas.at(-1)?.[0] === 'postgres') return { status: 200, body: JSON.stringify(readyHealth) };
    return {
      status: route === '/readyz' ? 503 : 500,
      body: route === '/readyz' ? JSON.stringify(storageUnavailableHealth) : 'storage unavailable',
    };
  };
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('/readyz') ? Response.json(readyHealth) : new Response(replayContents),
  );
  const outcome = assert.rejects(
    gate.verifyManagedDependencyRecovery('http://fixture', replayState),
    /Timed out waiting for PostgreSQL readiness failure/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(60_000);
  await outcome;
  assert.deepEqual(replicas, [
    ['minio', 0],
    ['minio', 1],
    ['postgres', 0],
    ['postgres', 1],
  ]);
  assert.equal(environmentChecks(), 0);
});

function createEnvironment(overrides = {}) {
  return {
    RIVET_K8S_RELEASE_GATE_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'kind-rivet-managed-release',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_RELEASE_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_RELEASE_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_RELEASE_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'release-gate',
    RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: 'release-gate-token',
    ...overrides,
  };
}

test('managed release gate fixture declares the runtime environment assertion', async () => {
  const fixturePath = path.join(
    rootDir,
    'deploy',
    'studio-server',
    'scripts',
    'fixtures',
    'managed-release-gate.rivet-project',
  );
  const fixture = await fs.readFile(fixturePath, 'utf8');

  assert.match(fixture, /\[environment-node\]:code "Environment"/);
  assert.match(fixture, /process\.env\.RIVET_RELEASE_GATE_VALUE/);
  assert.match(fixture, /output->"Delay" delay-node\/input1/);
});

test('managed release gate prints compact dependency startup states without exposing container messages', () => {
  assert.equal(
    summarizePodStartupState(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'release-gate-minio-123' },
            status: {
              phase: 'Pending',
              containerStatuses: [
                {
                  name: 'minio',
                  state: {
                    waiting: {
                      reason: 'ImagePullBackOff',
                      message: 'A registry response that must stay in the retained artifact only',
                    },
                  },
                },
              ],
            },
          },
        ],
      }),
    ),
    'release-gate-minio-123 (Pending): minio=ImagePullBackOff',
  );
  assert.equal(
    summarizePodStartupState(
      JSON.stringify({
        items: [
          {
            metadata: { name: 'release-gate-minio-unschedulable' },
            status: {
              phase: 'Pending',
              conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }],
              initContainerStatuses: { malformed: true },
              containerStatuses: null,
            },
          },
        ],
      }),
    ),
    'release-gate-minio-unschedulable (Pending): Unschedulable',
  );
  assert.equal(summarizePodStartupState('{not json'), 'Kubernetes did not return a readable pod list');
  assert.equal(summarizePodStartupState(JSON.stringify({ items: [] })), 'no matching dependency pod was created');
});

test('managed release gate reserves enough workers for deterministic execution node-drain coverage', async () => {
  const overlay = await fs.readFile(
    path.join(rootDir, 'deploy', 'studio-server', 'helm', 'overlays', 'managed-release-gate.yaml'),
    'utf8',
  );
  const kindTopology = await fs.readFile(
    path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kind-managed-release-cluster.yaml'),
    'utf8',
  );

  assert.match(overlay, /availability:\s*\n\s*topologySpread:\s*\n\s*whenUnsatisfiable: DoNotSchedule/);
  assert.equal((kindTopology.match(/- role: worker/g) ?? []).length, 3);
});

test('managed release gate proves cross-instance OAuth web-app revocation with its isolated loopback-only dummy provider', async () => {
  const [runner, overlay] = await Promise.all([
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kubernetes-managed-release-gate.mjs'),
      'utf8',
    ),
    fs.readFile(path.join(rootDir, 'deploy', 'studio-server', 'helm', 'overlays', 'managed-release-gate.yaml'), 'utf8'),
  ]);

  assert.match(runner, /verifyManagedWebAppAccessRevocation/);
  assert.match(runner, /createReleaseGateWebAppOAuthSession/);
  assert.match(runner, /Dummy OAuth login did not produce its expected redirect/);
  assert.match(runner, /managed OAuth web-app policy propagation/);
  assert.match(runner, /Removed OAuth WebSocket did not close with 1008 access revocation/);
  assert.match(runner, /Removed OAuth user could still start an action/);
  assert.match(runner, /Retained OAuth user action did not complete/);
  assert.match(runner, /await gate\.verifyManagedWebAppAccessRevocation\(baseUrl, persistedState\)/);
  assert.match(overlay, /RIVET_ENABLE_DEVELOPMENT_AUTH: ['"]true['"]/);
  assert.match(overlay, /RIVET_DEVELOPMENT_AUTH_CLIENTS: ['"]127\.0\.0\.1\/32,::1\/128['"]/);
  assert.match(overlay, /This is never a production deployment setting/);
});

test('managed release gate requires an exact explicitly allowed kube context', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: 'production',
        }),
      }),
    /must match exactly/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({ RIVET_K8S_RELEASE_GATE_ALLOW_CONTEXT: '' }),
      }),
    /ALLOW_CONTEXT is required/,
  );
});

test('managed release gate requires every immutable candidate image digest', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_API_IMAGE_DIGEST: 'latest',
        }),
      }),
    /must be a sha256 OCI digest/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_EXECUTOR_IMAGE_REPOSITORY: '',
        }),
      }),
    /EXECUTOR_IMAGE_REPOSITORY is required/,
  );
});

test('managed release gate accepts an exact prior API image only as a complete digest pair', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
        }),
      }),
    /must be supplied together/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
          RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_DIGEST: 'latest',
        }),
      }),
    /PREVIOUS_API_IMAGE_DIGEST must be a sha256 OCI digest/,
  );
  const config = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment({
      RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
      RIVET_K8S_RELEASE_GATE_PREVIOUS_API_IMAGE_DIGEST: digest('e'),
    }),
  });
  assert.equal(imageReference(config.previousApiImage!), `example.test/rivet/api@${digest('e')}`);
  assert.deepEqual(config.managedWorkflowSchema, {
    version: 15,
    minimumRollbackCompatibleVersion: 15,
  });
});

test('managed release gate renders managed storage and digest-pinned image values', () => {
  const config = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment(),
    mode: 'release',
  });
  const values = renderManagedReleaseGateValues(config);

  assert.equal(config.mode, 'release');
  assert.equal(values.images.proxy.pullPolicy, 'Always');
  assert.equal(values.images.proxy.digest, digest('a'));
  assert.equal(values.postgres.host, 'release-gate-postgres');
  assert.equal(values.objectStorage.endpoint, 'http://release-gate-minio:9000');
  assert.equal(values.objectStorage.bucket, 'rivet-release-gate');
  assert.deepEqual(values.workflowSchema.compatibility, { minimumVersion: 15, maximumVersion: 15 });
  assert.equal(imageReference(config.images.executor), `example.test/rivet/executor@${digest('d')}`);
});

test('combined backend does not require a standalone executor image in the Helm manifest', () => {
  const images = buildManagedReleaseGateConfig({ rootDir, env: createEnvironment() }).images;
  const combinedManifest = (['proxy', 'web', 'api'] as const)
    .map((component) => `image: ${imageReference(images[component])}`)
    .join('\n');

  assert.doesNotThrow(() => assertCandidateManifestImages(combinedManifest, images, 'release-gate'));
  assert.throws(
    () =>
      assertCandidateManifestImages(combinedManifest.replace(images.api.digest, digest('f')), images, 'release-gate'),
    /api manifest did not use the immutable candidate digest/,
  );
  assert.throws(
    () =>
      assertCandidateManifestImages(
        `${combinedManifest}\nimage: ${images.executor.repository}@${digest('f')}`,
        images,
        'release-gate',
      ),
    /executor manifest did not use the immutable candidate digest/,
  );
  assert.doesNotThrow(() =>
    assertCandidateManifestImages(
      `${combinedManifest}\nimage: ${imageReference(images.executor)}`,
      images,
      'release-gate',
    ),
  );
});

test('managed release gate allows preloaded local images without weakening the default pull policy', () => {
  const localConfig = buildManagedReleaseGateConfig({
    rootDir,
    env: createEnvironment({
      RIVET_K8S_RELEASE_GATE_IMAGE_PULL_POLICY: 'IfNotPresent',
    }),
  });

  assert.equal(localConfig.imagePullPolicy, 'IfNotPresent');
  assert.equal(renderManagedReleaseGateValues(localConfig).images.api.pullPolicy, 'IfNotPresent');
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_IMAGE_PULL_POLICY: 'Never',
        }),
      }),
    /must be Always or IfNotPresent/,
  );
});

test('managed release gate rejects unsafe artifact paths and requires registry credentials', () => {
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_ARTIFACTS_DIR: '../outside',
        }),
      }),
    /must remain inside the repository/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: '',
        }),
      }),
    /REGISTRY_USERNAME is required/,
  );
  assert.throws(
    () =>
      buildManagedReleaseGateConfig({
        rootDir,
        env: createEnvironment({
          RIVET_K8S_RELEASE_GATE_REGISTRY_USERNAME: 'ci-user',
          RIVET_K8S_RELEASE_GATE_REGISTRY_PASSWORD: '',
        }),
      }),
    /REGISTRY_PASSWORD is required/,
  );
});
function createProviderEnvironment(configFile: string, valuesFile: string, overrides = {}) {
  return {
    RIVET_K8S_PROVIDER_GATE_CONFIRM: 'deploy-staging',
    RIVET_K8S_PROVIDER_GATE_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_ALLOW_CONTEXT: 'provider-staging',
    RIVET_K8S_PROVIDER_GATE_CONFIG_FILE: configFile,
    RIVET_K8S_PROVIDER_GATE_VALUES_FILE: valuesFile,
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_REPOSITORY: 'example.test/rivet/proxy',
    RIVET_K8S_PROVIDER_GATE_PROXY_IMAGE_DIGEST: digest('a'),
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_REPOSITORY: 'example.test/rivet/web',
    RIVET_K8S_PROVIDER_GATE_WEB_IMAGE_DIGEST: digest('b'),
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_REPOSITORY: 'example.test/rivet/api',
    RIVET_K8S_PROVIDER_GATE_API_IMAGE_DIGEST: digest('c'),
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_REPOSITORY: 'example.test/rivet/executor',
    RIVET_K8S_PROVIDER_GATE_EXECUTOR_IMAGE_DIGEST: digest('d'),
    RIVET_K8S_PROVIDER_GATE_REGISTRY_USERNAME: 'provider-gate',
    RIVET_K8S_PROVIDER_GATE_REGISTRY_PASSWORD: 'provider-gate-token',
    ...overrides,
  };
}

test('managed release disruption gate covers WebSocket owner loss and managed dependency recovery', async () => {
  const [runner, fixture, overlay] = await Promise.all([
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kubernetes-managed-release-gate.mjs'),
      'utf8',
    ),
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'fixtures', 'managed-release-gate.rivet-project'),
      'utf8',
    ),
    fs.readFile(path.join(rootDir, 'deploy', 'studio-server', 'helm', 'overlays', 'managed-release-gate.yaml'), 'utf8'),
  ]);

  assert.match(fixture, /name: Long-running graph/);
  assert.match(fixture, /delay: 60000/);
  assert.match(fixture, /id: release-gate-long-run-button/);
  assert.match(runner, /web_app_action_runs/);
  assert.match(runner, /path\.join\(rootDir, ["']packages["'], ["']studio-server-api["'], ["']package\.json["']\)/);
  assert.doesNotMatch(runner, /path\.join\(rootDir, ["']wrapper["']/);
  assert.match(runner, /rootDir,\s+["']deploy["'],\s+["']studio-server["'],\s+["']scripts["'],\s+["']fixtures["'],/);
  assert.doesNotMatch(runner, /rootDir,\s+["']scripts["'],\s+["']fixtures["'],/);
  assert.match(runner, /run\.resume/);
  assert.match(runner, /action\.interrupted/);
  assert.match(runner, /["']--force["']/);
  assert.match(runner, /["']--grace-period=0["']/);
  assert.match(runner, /terminal\.reject\(error\)/);
  assert.match(runner, /["']interrupted WebSocket action replay["'],\s+async \(\) =>/);
  assert.match(runner, /resumed\.terminal,\s+30_000/);
  assert.match(runner, /120_000,\s+1_000/);
  assert.match(runner, /setDependencyReplicas\(\s*["']minio["']\s*,\s*0\)/);
  assert.match(runner, /setDependencyReplicas\(\s*["']postgres["']\s*,\s*0\)/);
  assert.match(runner, /["']workflow recovery after execution node drain["'],\s*\(\) =>[\s\S]*?this\.requestWorkflow/);
  assert.match(runner, /path: \/var\/lib\/rivet-managed-release-gate\/\$\{namespace\}\/postgres/);
  assert.match(runner, /path: \/var\/lib\/rivet-managed-release-gate\/\$\{namespace\}\/minio/);
  assert.equal(
    (runner.match(/type: DirectoryOrCreate/g) ?? []).length,
    2,
    'dependency pod replacement must retain PostgreSQL and MinIO fixture data',
  );
  assert.match(runner, /rotateAppSettingsKey/);
  assert.match(runner, /authorization: `Bearer \$\{this\.secrets\.rivetKey\}`/);
  assert.equal((runner.match(/this\.requestWorkflow\(/g) ?? []).length, 7);
  assert.match(runner, /result\?\.value\?\.type === ["']any["'] \? result\.value\.value : result/);
  assert.match(runner, /value\.environmentValue !== ["']managed-persistence["']/);
  assert.match(runner, /value\.hostname !== replacementExecutionPod/);
  assert.match(overlay, /shutdownGraceSeconds: 15/);
  assert.match(overlay, /terminationGracePeriodSeconds: 40/);
});

test('provider staging gate is explicitly confirmed, HTTPS-only, and scoped to a staging namespace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-provider-gate-test-'));
  const configFile = path.join(directory, 'provider-gate.json');
  const valuesFile = path.join(directory, 'values.yaml');
  const interruptionFile = path.join(directory, 'block-postgres.yaml');
  const config = {
    namespace: 'rivet-staging-release',
    release: 'rivet-staging',
    gatewayMode: 'external',
    baseUrl: 'https://rivet-staging.example.test',
    requestHeaders: { authorization: 'Bearer test-only' },
    workflowProbe: {
      path: '/workflows/provider-gate',
      method: 'POST',
      body: { input: 'provider-gate' },
      contains: 'provider-gate',
    },
    webAppProbe: {
      path: '/apps/provider-gate',
      contains: 'Provider gate',
    },
    keyRotation: {
      currentSecretName: 'rivet-settings-old',
      nextSecretName: 'rivet-settings-new',
    },
    legacyImport: {
      probe: {
        path: '/workflows/legacy-import',
        method: 'POST',
        body: { input: 'legacy' },
        contains: 'legacy',
      },
    },
    interruptionManifests: {
      postgres: {
        applyFile: 'block-postgres.yaml',
        restoreFile: 'block-postgres.yaml',
        restoreAction: 'delete',
      },
    },
  };
  try {
    await Promise.all([
      fs.writeFile(configFile, JSON.stringify(config)),
      fs.writeFile(valuesFile, 'vault:\n  enabled: true\n'),
      fs.writeFile(
        interruptionFile,
        'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: block-postgres\n  namespace: rivet-staging-release\n',
      ),
    ]);
    const providerConfig = buildManagedProviderGateConfig({
      rootDir,
      env: createProviderEnvironment(configFile, valuesFile),
    });
    assert.equal(providerConfig.namespace, 'rivet-staging-release');
    assert.equal(providerConfig.gatewayMode, 'external');
    assert.deepEqual(Object.keys(providerConfig.images).sort(), ['api', 'executor', 'web']);
    const externalManifest = `image: ${imageReference(providerConfig.images.api)}\nimage: ${imageReference(providerConfig.images.web)}`;
    assert.doesNotThrow(() => assertCandidateManifestImages(externalManifest, providerConfig.images, 'provider-gate'));
    assert.throws(
      () =>
        assertCandidateManifestImages(
          externalManifest.replace(providerConfig.images.web.digest, digest('f')),
          providerConfig.images,
          'provider-gate',
        ),
      /web manifest did not use the immutable candidate digest/,
    );
    assert.equal(providerConfig.baseUrl, 'https://rivet-staging.example.test');
    assert.equal(providerConfig.interruptionManifests[0]?.restoreAction, 'delete');
    assert.equal(providerConfig.keyRotation?.nextSecretName, 'rivet-settings-new');
    assert.equal(providerConfig.registry.secretName, 'rivet-managed-provider-gate-registry');

    for (const baseUrl of ['https://[::1]', 'https://127.1', 'https://staging.localhost.']) {
      await fs.writeFile(configFile, JSON.stringify({ ...config, baseUrl }));
      assert.throws(
        () => buildManagedProviderGateConfig({ rootDir, env: createProviderEnvironment(configFile, valuesFile) }),
        /must be a non-local HTTPS URL/,
      );
    }

    await fs.writeFile(configFile, JSON.stringify({ ...config, gatewayMode: 'embedded' }));
    assert.ok(
      buildManagedProviderGateConfig({ rootDir, env: createProviderEnvironment(configFile, valuesFile) }).images.proxy,
    );
    await fs.writeFile(configFile, JSON.stringify({ ...config, gatewayMode: undefined }));
    assert.throws(
      () => buildManagedProviderGateConfig({ rootDir, env: createProviderEnvironment(configFile, valuesFile) }),
      /gatewayMode must be external or embedded/,
    );
    await fs.writeFile(configFile, JSON.stringify({ ...config, requestHeaders: { 'X-Rivet-Proxy-Auth': 'spoofed' } }));
    assert.throws(
      () => buildManagedProviderGateConfig({ rootDir, env: createProviderEnvironment(configFile, valuesFile) }),
      /reserved for the trusted gateway/,
    );
    for (const unsafeConfig of [
      { ...config, workflowProbe: { ...config.workflowProbe, path: '/\\attacker.example/collect' } },
      { ...config, webAppProbe: { ...config.webAppProbe, path: '/\\attacker.example/collect' } },
      { ...config, legacyImport: { probe: { ...config.legacyImport.probe, path: '/\\attacker.example/collect' } } },
    ]) {
      await fs.writeFile(configFile, JSON.stringify(unsafeConfig));
      assert.throws(
        () => buildManagedProviderGateConfig({ rootDir, env: createProviderEnvironment(configFile, valuesFile) }),
        /must be an absolute path on the configured staging host/,
      );
    }
    await fs.writeFile(configFile, JSON.stringify(config));

    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile, {
            RIVET_K8S_PROVIDER_GATE_CONFIRM: 'production',
          }),
        }),
      /must equal deploy-staging/,
    );
    await fs.writeFile(
      configFile,
      JSON.stringify({
        ...config,
        interruptionManifests: {
          postgres: {
            ...config.interruptionManifests.postgres,
            applyFile: 'missing-network-policy.yaml',
          },
        },
      }),
    );
    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile),
        }),
      /must identify a readable regular file/,
    );
    await fs.writeFile(configFile, JSON.stringify({ ...config, namespace: 'rivet-production' }));
    assert.throws(
      () =>
        buildManagedProviderGateConfig({
          rootDir,
          env: createProviderEnvironment(configFile, valuesFile),
        }),
      /must start with rivet-staging-/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('provider staging gate preserves secret inputs outside uploaded artifacts', async () => {
  const [runner, workflow] = await Promise.all([
    fs.readFile(
      path.join(rootDir, 'deploy', 'studio-server', 'scripts', 'kubernetes-managed-provider-gate.mjs'),
      'utf8',
    ),
    fs.readFile(path.join(rootDir, '.github', 'workflows', 'studio-server-images.yml'), 'utf8'),
  ]);

  assert.match(runner, /os\.tmpdir\(\)/);
  assert.match(
    runner,
    /path\.dirname\(fileURLToPath\(import\.meta\.url\)\),\s*["']\.\.["'],\s*["']\.\.["'],\s*["']\.\.["']\s*\)/,
  );
  assert.match(runner, /rivet-managed-provider-gate-/);
  assert.match(runner, /NetworkPolicy resources in/);
  assert.match(runner, /helm.*rollback/s);
  assert.match(runner, /inspectReleaseHistory/);
  assert.match(runner, /release:\\s\+not found/);
  assert.match(runner, /could not inspect Helm history/);
  assert.match(runner, /reuseValues: releaseHistory\.hasHistory/);
  assert.match(runner, /["']--atomic["']/);
  assert.match(runner, /reuseValues: true,\s+setValues: this\.getFinalAppSettingsKeyValues\(\)/);
  assert.match(runner, /app\.kubernetes\.io\/instance=\$\{this\.config\.release\}/);
  assert.match(runner, /gateway\.mode=\$\{this\.config\.gatewayMode\}/);
  assert.match(runner, /\/internal\/workflows\/\$\{endpointName\}/);
  assert.match(runner, /readiness recovery[\s\S]*?await this\.assertPublicSurface\(\);/);
  assert.match(runner, /refusing to overwrite registry secret/);
  assert.match(runner, /could not determine whether registry secret/);
  assert.match(workflow, /managed-kubernetes-provider-gate:/);
  assert.match(workflow, /timeout-minutes: 180/);
  assert.match(workflow, /environment:\r?\n\s+name: rivet-managed-staging/);
  assert.doesNotMatch(workflow, /\$\{\{\s*runner\.temp\s*\}\}/);
  assert.match(workflow, /Define Protected Staging File Paths/);
  assert.match(workflow, /echo "KUBECONFIG=\$RUNNER_TEMP\/rivet-managed-staging\.kubeconfig"/);
  assert.match(workflow, /RIVET_K8S_STAGING_KUBECONFIG_B64/);
  assert.match(workflow, /must not contain symbolic or hard links/);
  assert.match(workflow, /artifacts\/kubernetes-managed-provider-gate/);
});
