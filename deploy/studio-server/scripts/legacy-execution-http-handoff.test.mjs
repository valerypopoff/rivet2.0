import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, createServer, get } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertUnpooledExecutionUpstream,
  bufferedResponseProbe,
  createLegacyExecutionHttpHandoff,
  recoverLegacyHttpService,
} from './lib/legacy-execution-http-handoff.mjs';

export function fixture({ safe = false } = {}) {
  let time = 0,
    version = 1;
  const calls = [];
  const labels = { 'app.kubernetes.io/instance': 'rivet', 'app.kubernetes.io/component': 'execution' };
  const service = {
    metadata: { name: 'execution', uid: 'service', resourceVersion: '1', labels },
    spec: { selector: labels, ports: [{ port: 80, targetPort: 'execution-http' }] },
  };
  let live = structuredClone(service);
  const owners = [0, 1].map((i) => ({ name: 'old-' + i, uid: 'old-uid-' + i }));
  const pods = new Map(owners.map((pod) => [pod.name, pod]));
  const operation = {
    record: { phase: 'owners', executionPool: { owners } },
    assertLease() {},
    async checkpoint(changes) {
      this.record = structuredClone({ ...this.record, ...changes });
    },
  };
  const options = {
    service,
    release: 'rivet',
    namespace: 'default',
    plan: { previous: { replicas: 2 }, candidate: { name: 'candidate' } },
    candidateTemplate: { metadata: { labels: { ...labels, 'rivet.dev/execution-pool': 'b' } } },
    observePod: async (name) => pods.get(name),
    assertCapacity: async () => {
      calls.push('capacity');
    },
    timeoutMs: 10_000,
    clock: {
      now: () => time,
      wait: async () => {
        time += 1000;
        await f.onTick?.(time);
      },
    },
    kube: async (args) => {
      calls.push(args.slice(0, 3).join(':'));
      if (args[0] === 'get' && args[1] === 'service') return { stdout: JSON.stringify(live) };
      if (args[0] === 'get' && args[1] === 'pod')
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: 'proxy-0', uid: 'proxy', labels: { 'app.kubernetes.io/instance': 'rivet' } },
                status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
              },
              ...f.extraProxies,
            ],
          }),
        };
      if (args[0] === 'exec') {
        if (args.includes('proxy')) return { stdout: f.proxyConfiguration };
        assert.deepEqual(args.slice(5), bufferedResponseProbe);
        return { stdout: JSON.stringify({ protocol: 1, bufferedResponseSafe: safe }) };
      }
      if (args[1] === 'endpointslice') return { stdout: JSON.stringify({ items: f.slices() }) };
      if (args[0] === 'patch') {
        const patch = JSON.parse(args.at(-1));
        assert.equal(patch[0].value, live.metadata.uid);
        assert.equal(patch[1].value, live.metadata.resourceVersion);
        assert.deepEqual(patch[2].value, live.spec.selector);
        if (f.failBeforePatch) throw Error('uncertain write');
        live.spec.selector = patch[3].value;
        live.metadata.resourceVersion = String(++version);
        if (f.failAfterPatch) {
          f.failAfterPatch = false;
          throw Error('lost acknowledgement');
        }
        return { stdout: '{}' };
      }
      throw Error('Unexpected fixture command: ' + args.join(' '));
    },
  };
  const f = {
    options,
    operation,
    owners,
    pods,
    calls,
    extraProxies: [],
    proxyConfiguration:
      'upstream rivet_execution { zone rivet_execution 64k; keepalive 0; server execution.default.svc.cluster.local:80; }',
    now: () => time,
    live: () => live,
    slices: () => [
      {
        metadata: { labels: { 'kubernetes.io/service-name': 'execution' } },
        endpoints: [0, 1].map((i) => ({
          conditions: { ready: true },
          targetRef: {
            kind: 'Pod',
            namespace: 'default',
            name: 'candidate-' + i,
            uid: 'candidate-uid-' + i,
          },
        })),
      },
    ],
    create: () => createLegacyExecutionHttpHandoff(options),
    patchCount: () => calls.filter((call) => call.startsWith('patch:')).length,
  };
  return f;
}

test('legacy owners retain admission for propagation plus 300 seconds before unsafe withdrawal', async () => {
  const f = fixture(),
    handoff = f.create();
  await handoff.prepare(f.operation);
  assert.equal(f.now(), 360_000);
  assert.equal(f.patchCount(), 1);
  assert.equal(f.operation.record.executionPool.legacyHttp.settled, true);
  assert.equal(f.live().spec.selector['rivet.dev/execution-pool'], 'b');
  await handoff.beforeWithdraw(f.operation);
  assert.equal(f.now(), 360_000, 'One barrier per process, not per worker');
  await handoff.finish(f.operation);
  await handoff.finish(f.operation);
  assert.equal(f.patchCount(), 2, 'Restore exactly once');
  assert.deepEqual(f.live().spec.selector, f.options.service.spec.selector);
});

test('fixed running images skip Service mutations, proxy exec and the compatibility wait', async () => {
  const f = fixture({ safe: true }),
    handoff = f.create();
  await handoff.prepare(f.operation);
  await handoff.beforeWithdraw(f.operation);
  await handoff.finish(f.operation);
  assert.equal(f.now(), 0);
  assert.equal(f.patchCount(), 0);
  assert.ok(!f.calls.some((call) => call === 'exec:proxy-0:-c'));
});

test('committed uncertain routing write is read back on recovery, never repeated', async () => {
  const f = fixture();
  f.failAfterPatch = true;
  await assert.rejects(f.create().prepare(f.operation), /lost acknowledgement/);
  assert.equal(f.operation.record.executionPool.legacyHttp.routeIssued, true);
  await f.create().prepare(f.operation);
  assert.equal(f.patchCount(), 1);
  assert.equal(f.now(), 360_000);
});

test('uncommitted uncertain writes retain original owners and are never replayed', async () => {
  const f = fixture();
  f.failBeforePatch = true;
  await assert.rejects(f.create().prepare(f.operation), /uncertain write/);
  f.failBeforePatch = false;
  await assert.rejects(f.create().prepare(f.operation), /selector changed/);
  assert.equal(f.patchCount(), 1);
  assert.equal(f.now(), 0);
});

test('restoration after a lost acknowledgement observes the original selector without replay', async () => {
  const f = fixture(),
    handoff = f.create();
  await handoff.prepare(f.operation);
  f.failAfterPatch = true;
  await assert.rejects(handoff.finish(f.operation), /lost acknowledgement/);
  await f.create().finish(f.operation);
  assert.equal(f.patchCount(), 2);
});

test('recovery before the first remaining unsafe command observes a fresh response interval', async () => {
  const f = fixture();
  await f.create().prepare(f.operation);
  await f.create().beforeWithdraw(f.operation);
  assert.equal(f.now(), 720_000);
  assert.equal(f.patchCount(), 1);
});

test('a returning old endpoint or insufficient candidate floor restarts the complete interval', async () => {
  const f = fixture(),
    normal = f.slices;
  f.slices = () => {
    const slices = normal();
    if (f.now() === 5000)
      slices[0].endpoints[1].targetRef = {
        kind: 'Pod',
        namespace: 'default',
        ...f.owners[1],
      };
    return slices;
  };
  await f.create().prepare(f.operation);
  assert.equal(f.now(), 366_000);
});

for (const issue of ['uid', 'selector', 'ports', 'owner', 'foreign-endpoint', 'lease'])
  test(`changed ${issue} prevents unsafe withdrawal`, async () => {
    const f = fixture();
    f.onTick = () => {
      if (issue === 'uid') f.live().metadata.uid = 'foreign';
      if (issue === 'selector') f.live().spec.selector = {};
      if (issue === 'ports') f.live().spec.ports = [];
      if (issue === 'owner') f.pods.set('old-1', { name: 'old-1', uid: 'foreign' });
      if (issue === 'foreign-endpoint')
        f.slices = () => [
          {
            metadata: { labels: { 'kubernetes.io/service-name': 'execution' } },
            endpoints: [{ targetRef: { uid: 'foreign', name: 'other-0', kind: 'Pod', namespace: 'default' } }],
          },
        ];
      if (issue === 'lease')
        f.operation.assertLease = () => {
          throw Error('lease lost');
        };
    };
    await assert.rejects(f.create().prepare(f.operation));
    assert.notEqual(f.operation.record.executionPool.legacyHttp?.settled, true);
  });

test('malformed capability and probe errors abort before Service mutation', async () => {
  for (const response of ['{}', 'bad json', '{"protocol":1,"bufferedResponseSafe":"true"}']) {
    const f = fixture(),
      kube = f.options.kube;
    f.options.kube = async (args) => (args[0] === 'exec' ? { stdout: response } : kube(args));
    await assert.rejects(f.create().prepare(f.operation));
    assert.equal(f.patchCount(), 0);
  }
});

test(
  'the deployed-code probe distinguishes a missing legacy helper from a broken fixed module',
  { skip: process.platform !== 'linux' },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rivet-http-capability-'));
    const file = path.join(directory, 'retirement-http-connections.mjs');
    const probe = () =>
      spawnSync(
        process.execPath,
        [
          ...bufferedResponseProbe.slice(1, -1),
          bufferedResponseProbe
            .at(-1)
            .replace('/app/packages/studio-server-api/dist/studio-server-api/src/retirement-http-connections.js', file),
        ],
        { encoding: 'utf8' },
      );
    try {
      let result = probe();
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).bufferedResponseSafe, false);
      await writeFile(file, 'export function createRetirementHttpConnections() {}');
      result = probe();
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).bufferedResponseSafe, true);
      for (const invalid of ['export const wrong = true;', "import './missing-dependency.mjs';"]) {
        await writeFile(file, invalid);
        assert.notEqual(
          probe().status,
          0,
          'Broken modules cannot claim the fixed capability or trigger legacy fallback',
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('live proxy upstream pooling is forbidden, frontend pooling remains allowed', async () => {
  assertUnpooledExecutionUpstream(
    'keepalive_timeout 620s; upstream rivet_execution { # keepalive 32;\n keepalive 0; }',
  );
  for (const config of [
    '',
    'upstream rivet_execution { }',
    'upstream rivet_execution { keepalive 32; }',
    'upstream rivet_execution { keepalive 0; keepalive 1; }',
  ]) {
    assert.throws(() => assertUnpooledExecutionUpstream(config));
    const f = fixture();
    f.proxyConfiguration = config;
    await assert.rejects(f.create().prepare(f.operation));
    assert.equal(f.patchCount(), 0);
  }
});

test('an unpooled upstream must still use the execution Service being handed off', async () => {
  for (const server of [
    'headless.default.svc.cluster.local:80',
    'execution.other.svc.cluster.local:80',
    'execution.default.svc.cluster.local:81',
  ]) {
    const f = fixture();
    f.proxyConfiguration = `upstream rivet_execution { keepalive 0; server ${server}; }`;
    await assert.rejects(f.create().prepare(f.operation), /bypasses the handoff Service/);
    assert.equal(f.patchCount(), 0);
  }
});

test('a listed terminating proxy is still checked; confirmed exit is safe but replacements are not ignored', async () => {
  for (const state of ['running', 'gone', 'terminated', 'replacement']) {
    const f = fixture(),
      kube = f.options.kube;
    const pod = {
      metadata: {
        name: 'proxy-old',
        uid: 'old-proxy',
        deletionTimestamp: 'now',
        labels: { 'app.kubernetes.io/instance': 'rivet' },
      },
      status: { phase: 'Running' },
    };
    f.extraProxies = [pod];
    f.options.kube = async (args) => {
      if (args[0] === 'exec' && args[1] === pod.metadata.name) throw Error('proxy exec failed');
      if (args[0] === 'get' && args[2] === pod.metadata.name) {
        if (state === 'gone') return { stdout: '' };
        const current = structuredClone(pod);
        if (state === 'terminated') current.status.containerStatuses = [{ name: 'proxy', state: { terminated: {} } }];
        if (state === 'replacement') current.metadata.uid = 'replacement';
        return { stdout: JSON.stringify(current) };
      }
      return kube(args);
    };
    if (['gone', 'terminated'].includes(state)) await f.create().prepare(f.operation);
    else {
      await assert.rejects(f.create().prepare(f.operation), /proxy exec failed/);
      assert.equal(f.patchCount(), 0);
    }
  }
});

test('only the exact journaled temporary Service selector is accepted during recovery', async () => {
  const f = fixture();
  await f.create().prepare(f.operation);
  const state = f.operation.record;
  assert.deepEqual(
    recoverLegacyHttpService(f.live(), f.options.service, state).spec.selector,
    f.options.service.spec.selector,
  );
  for (const change of [
    (live) => {
      live.metadata.uid = 'foreign';
    },
    (live) => {
      live.spec.selector.extra = 'foreign';
    },
  ]) {
    const live = structuredClone(f.live());
    change(live);
    assert.equal(recoverLegacyHttpService(live, f.options.service, state), live);
  }
  const complete = { ...state, phase: 'complete' };
  assert.equal(recoverLegacyHttpService(f.live(), f.options.service, complete), f.live());
});

test(
  'real legacy HTTP backpressure: handoff preserves the full body and reused frontend connections',
  { skip: process.platform !== 'linux', timeout: 15_000 },
  async (t) => {
    for (const protectedHandoff of [false, true])
      await t.test(String(protectedHandoff), async () => {
        const f = fixture(),
          body = Buffer.alloc(16 * 1024 * 1024, 'h');
        let withdrawing = false,
          pendingResponse,
          pausedUpstream,
          releaseBody;
        const old = createServer((req, res) => {
          res.once('finish', () => {
            if (withdrawing) old.closeIdleConnections();
          });
          if (req.url === '/large') {
            pendingResponse = res;
            res.setHeader('Content-Length', body.length);
            res.end(body);
          } else res.end('old');
        });
        const candidate = createServer((_req, res) => res.end('candidate'));
        const proxy = createServer((req, res) => {
          const target = f.live().spec.selector['rivet.dev/execution-pool'] ? candidate : old;
          // Mirrors the verified nginx execution upstream keepalive 0.
          const upstream = get(`http://127.0.0.1:${target.address().port}${req.url}`, { agent: false }, (input) => {
            const headers = { ...input.headers };
            delete headers.connection; // nginx keeps frontend/upstream lifetimes independent.
            res.writeHead(input.statusCode, headers);
            res.flushHeaders();
            input.once('error', (error) => res.destroy(error));
            if (req.url === '/large') {
              pausedUpstream = input;
              input.pause();
              releaseBody = () => input.pipe(res);
            } else input.pipe(res);
          });
          upstream.once('error', (error) => res.destroy(error));
        });
        const servers = [old, candidate, proxy],
          agent = new Agent({ keepAlive: true, maxSockets: 1 });
        try {
          for (const server of servers) {
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
          }
          const read = (path, keepAlive = agent) =>
            new Promise((resolve, reject) => {
              const request = get(`http://127.0.0.1:${proxy.address().port}${path}`, { agent: keepAlive }, (res) => {
                const socket = res.socket;
                let received = 0,
                  text = '';
                res.on('data', (bytes) => {
                  received += bytes.length;
                  if (path !== '/large') text += bytes;
                });
                res.once('end', () => resolve({ complete: true, received, text, port: socket.localPort }));
                res.once('error', () => resolve({ complete: false, received }));
              });
              request.once('error', reject);
            });
          const warm = await read('/warm');
          assert.equal(warm.text, 'old');
          const large = read('/large', false);
          while (!pausedUpstream) await new Promise((resolve) => setImmediate(resolve));
          assert.equal(pendingResponse.writableEnded, true);
          assert.equal(pendingResponse.writableFinished, false, 'Fixture must exercise real socket backpressure');
          if (protectedHandoff) {
            f.onTick = async (time) => {
              if (time === 1000 || time === 300_000) {
                const response = await read('/reused');
                assert.equal(response.text, 'candidate');
                assert.equal(response.port, warm.port, 'The same frontend connection routes to the candidate');
              }
              if (time === 180_000) {
                releaseBody();
                const response = await large;
                assert.equal(response.complete, true);
                assert.equal(response.received, body.length);
              }
            };
            const handoff = f.create();
            await handoff.prepare(f.operation);
            await handoff.beforeWithdraw(f.operation);
            assert.equal(f.now(), 360_000);
          }
          withdrawing = true;
          old.closeIdleConnections();
          if (!protectedHandoff) {
            releaseBody();
            const response = await large;
            assert.equal(response.complete, false, 'Without the barrier, the real legacy response must truncate');
            assert.ok(response.received < body.length);
          } else assert.equal((await large).received, body.length);
        } finally {
          agent.destroy();
          for (const server of servers) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
          }
        }
      });
  },
);
