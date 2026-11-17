import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createServer } from 'node:http';
import express from 'express';
import { listenTestServer } from './helpers/http-server-harness.js';
import { createResourceReportRouter } from '../resource-monitoring/routes.js';
import { getExpectedExecutorAuthToken } from '../auth.js';
import { createResourceCounterReader, resolveCgroupPaths } from '../resource-monitoring/counters.js';
import { createResourceSampler } from '../resource-monitoring/sampler.js';
import {
  ResourceMonitoringHub,
  unavailableResourceHistory,
  validateResourceReport,
} from '../resource-monitoring/service.js';
import { resourceStatistics, fillResourceHistory } from '../resource-monitoring/history.js';
import type {
  ResourceReport,
  ResourceInstanceHistory,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';

const allocation = {
  cpuRequestMillicores: null,
  memoryRequestBytes: null,
  cpuLimitMillicores: null,
  memoryLimitBytes: null,
};
function report(at: number, id = 'worker'): ResourceReport {
  return {
    identity: { installation: 'test/rivet', incarnation: id, role: 'execution', name: 'worker', source: 'cgroup-v2' },
    allocation: { ...allocation },
    droppedSamples: 0,
    buckets: [
      {
        at: Math.floor(at / 60000) * 60000,
        revision: 1,
        samples: [
          {
            at,
            durationMs: 5000,
            cpuMillicores: 100,
            memoryBytes: 1024,
            workingSetBytes: 512,
            lifetimeMemoryPeakBytes: null,
            activeRuns: 1,
            runLimit: 32,
          },
        ],
      },
    ],
  };
}

test('cgroup resolution follows real controller roots and rejects inaccessible ancestors', () => {
  assert.deepEqual(
    resolveCgroupPaths('0::/tenant/container', '1 0 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw'),
    [
      {
        version: 2,
        cpu: '/sys/fs/cgroup/container',
        memory: '/sys/fs/cgroup/container',
        quota: '/sys/fs/cgroup/container',
      },
    ],
  );
  assert.deepEqual(resolveCgroupPaths('0::/', '1 0 0:1 /docker/one /sys/fs/cgroup rw - cgroup2 cgroup rw'), [
    { version: 2, cpu: '/sys/fs/cgroup', memory: '/sys/fs/cgroup', quota: '/sys/fs/cgroup' },
  ]);
  assert.deepEqual(resolveCgroupPaths('0::/../../host', '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw'), []);
  assert.deepEqual(
    resolveCgroupPaths(
      '3:cpu,cpuacct:/x/one\n4:memory:/x/one',
      '1 0 0:1 /x /cg/cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 /x /cg/memory rw - cgroup cgroup rw,memory',
    ),
    [{ version: 1, cpu: '/cg/cpu/one', quota: '/cg/cpu/one', memory: '/cg/memory/one' }],
  );
});

test('v2 reports charged memory, estimated working set, quota and lifetime peak separately', async () => {
  const files: Record<string, string> = {
    '/proc/self/cgroup': '0::/',
    '/proc/self/mountinfo': '1 0 0:1 / /cg rw - cgroup2 cgroup rw',
    '/cg/cpu.stat': 'usage_usec 5000000\nuser_usec 1',
    '/cg/memory.current': '1000',
    '/cg/memory.stat': 'inactive_file 400',
    '/cg/memory.peak': '1500',
    '/cg/cpu.max': '200000 100000',
    '/cg/memory.max': 'max',
  };
  const reader = await createResourceCounterReader({
    platform: 'linux',
    containerized: true,
    read: async (file) => {
      if (!(file in files)) throw Error('missing');
      return files[file]!;
    },
  });
  assert.equal(reader.source, 'cgroup-v2');
  assert.deepEqual(await reader.read(), {
    cpuMicros: 5000000,
    memoryBytes: 1000,
    workingSetBytes: 600,
    lifetimeMemoryPeakBytes: 1500,
    cpuLimitMillicores: 2000,
    memoryLimitBytes: null,
  });
});

test('v1 counters retain precision after long CPU lifetimes; non-container fallback never reads host cgroups', async () => {
  const files: Record<string, string> = {
    '/proc/self/cgroup': '1:cpu,cpuacct:/one\n2:memory:/one',
    '/proc/self/mountinfo':
      '1 0 0:1 / /cpu rw - cgroup cgroup rw,cpu,cpuacct\n2 0 0:2 / /mem rw - cgroup cgroup rw,memory',
    '/cpu/one/cpuacct.usage': '900719925474099900',
    '/mem/one/memory.usage_in_bytes': '1000',
    '/mem/one/memory.stat': 'total_inactive_file 100',
  };
  const reader = await createResourceCounterReader({
    platform: 'linux',
    containerized: true,
    read: async (file) => {
      if (!(file in files)) throw Error('absent');
      return files[file]!;
    },
  });
  assert.equal(reader.source, 'cgroup-v1');
  assert.equal((await reader.read()).cpuMicros, 900719925474099);
  const fallback = await createResourceCounterReader({
    platform: 'linux',
    containerized: false,
    read: async () => {
      assert.fail('Host counters must not be read');
    },
    processCounters: () => ({ cpuMicros: 42, memoryBytes: 88 }),
  });
  assert.equal(fallback.source, 'node-process');
  assert.equal((await fallback.read()).workingSetBytes, null);
});

test('sampler uses real elapsed time, resets CPU baselines and bounds outage buffers and reporting', async () => {
  let at = Date.now(),
    cpu = 1000,
    active = 3,
    mode: 'enforce' | 'observe' | 'disabled' = 'enforce',
    calls = 0,
    finish!: () => void;
  const sent: ResourceReport[] = [];
  const sampler = createResourceSampler({
    identity: report(at).identity,
    allocation: { ...allocation },
    now: () => at,
    monotonic: () => at,
    activity: () => ({ activeRuns: active, maxActiveRuns: 32, mode }),
    reader: {
      source: 'node-process',
      read: async () => ({
        cpuMicros: cpu,
        memoryBytes: 100,
        workingSetBytes: null,
        lifetimeMemoryPeakBytes: null,
        cpuLimitMillicores: null,
        memoryLimitBytes: null,
      }),
    },
    report: async (payload) => {
      calls++;
      sent.push(payload);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  await sampler.sample();
  at += 5000;
  cpu += 5000000;
  await sampler.sample();
  const first = sampler.flush(true);
  await setImmediate();
  assert.equal(sampler.flush(true), first);
  assert.equal(calls, 1);
  assert.equal(sent[0]!.buckets.flatMap((b) => b.samples).at(-1)!.cpuMillicores, 1000);
  assert.equal(sent[0]!.buckets.flatMap((b) => b.samples).at(-1)!.runLimit, 32);
  at += 5000;
  cpu = 1;
  active = 2;
  mode = 'observe';
  await sampler.sample();
  for (let i = 0; i < 8; i++) {
    at += 60000;
    await sampler.sample();
  }
  assert.ok(sampler.diagnostics().bufferedMinutes <= 6);
  assert.ok(sampler.diagnostics().droppedSamples > 0);
  finish();
  await first;
  const second = sampler.flush(true);
  await setImmediate();
  assert.ok(sent[1]!.buckets.flatMap((b) => b.samples).every((s) => s.cpuMillicores === null));
  assert.ok(
    sent[1]!.buckets.flatMap((b) => b.samples).every((s) => s.runLimit === null),
    'Observe mode has no enforced limit',
  );
  finish();
  await second;
  mode = 'disabled';
  active = 0;
  at += 5000;
  await sampler.sample();
  const third = sampler.flush(true);
  await setImmediate();
  const disabled = sent[2]!.buckets.flatMap((b) => b.samples).at(-1)!;
  assert.equal(disabled.activeRuns, null, 'Disabled admission does not track active runs');
  assert.equal(disabled.runLimit, null);
  finish();
  await third;
  sampler.stop();
});

test('duration-weighted percentiles and missing chart intervals retain their meaning', () => {
  const stats = resourceStatistics({ sum: 1090, weight: 100, peak: 100, histogram: { '10': 99, '100': 1 } });
  assert.equal(stats.average, 10.9);
  assert.equal(stats.p95, 10);
  assert.equal(stats.peak, 100);
  assert.equal(resourceStatistics().average, null);
  assert.deepEqual(resourceStatistics({ sum: 0, weight: 0, peak: 1000, histogram: { '1000': 0 } }), {
    average: null,
    p95: null,
    peak: 1000,
    coverageMs: 0,
  });
  assert.equal(fillResourceHistory([], 0, 120000, 60000).length, 3);
  assert.equal(fillResourceHistory([], 0, 120000, 60000)[1]!.cpuMillicores, null);
});

test('samplers share five-second boundaries without duplicating timers', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1001 });
  let reads = 0;
  const sampler = createResourceSampler({
    identity: report(Date.now()).identity,
    allocation: { ...allocation },
    monotonic: () => Date.now(),
    activity: () => null,
    report: async () => {},
    reader: {
      source: 'node-process',
      read: async () => {
        reads++;
        return {
          cpuMicros: 1000,
          memoryBytes: 100,
          workingSetBytes: null,
          lifetimeMemoryPeakBytes: null,
          cpuLimitMillicores: null,
          memoryLimitBytes: null,
        };
      },
    },
  });
  sampler.start();
  sampler.start();
  await setImmediate();
  assert.equal(reads, 1);
  t.mock.timers.tick(3998);
  await setImmediate();
  assert.equal(reads, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(reads, 2);
  sampler.stop();
  t.mock.timers.tick(10000);
  await setImmediate();
  assert.equal(reads, 2);
});

test('internal resource reports authenticate before parsing and never admit browser credentials', async () => {
  const previous = process.env.RIVET_KEY;
  process.env.RIVET_KEY = 'resource-monitoring-local-test';
  const app = express();
  app.use('/reports', createResourceReportRouter());
  const server = await listenTestServer(createServer(app));
  try {
    assert.equal(
      (
        await fetch(server.baseUrl + '/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{bad-json',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(server.baseUrl + '/reports', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rivet-executor-auth': getExpectedExecutorAuthToken() },
          body: '{}',
        })
      ).status,
      503,
    );
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.RIVET_KEY;
    else process.env.RIVET_KEY = previous;
  }
});

test('history requests share cached work, including outages; reports are scoped and idempotently batched', async () => {
  let at = Date.now(),
    reads = 0,
    writes = 0,
    fail = false;
  const hub = new ResourceMonitoringHub(
    'test/rivet',
    {
      write: async () => {
        writes++;
      },
      cleanup: async () => {},
      history: async (period, now) => {
        reads++;
        await setImmediate();
        if (fail) throw Error('offline');
        return { ...unavailableResourceHistory(period, now), available: true, error: null };
      },
    },
    () => at,
  );
  hub.ingest(report(at));
  await hub.flush();
  await hub.flush();
  assert.equal(writes, 1);
  const results = await Promise.all(Array.from({ length: 8 }, () => hub.history('1h')));
  assert.equal(reads, 1);
  assert.equal(results[0]!.instances.length, 1);
  at += 31000;
  fail = true;
  await hub.history('1h');
  await hub.history('1h');
  assert.equal(reads, 2);
  assert.throws(() =>
    validateResourceReport(
      { ...report(at), identity: { ...report(at).identity, installation: 'another/installation' } },
      'test/rivet',
      at,
    ),
  );
  assert.throws(() => hub.ingest({ ...report(at), buckets: Array.from({ length: 7 }, () => report(at).buckets[0]!) }));
  assert.throws(
    () => hub.ingest({ ...report(at), identity: { ...report(at).identity, name: 12 } }),
    /Invalid resource identity/,
  );
  const duplicate = report(Math.floor(at / 5000) * 5000);
  duplicate.buckets[0]!.samples.push({
    ...duplicate.buckets[0]!.samples[0]!,
    at: duplicate.buckets[0]!.samples[0]!.at + 1,
  });
  assert.throws(() => hub.ingest(duplicate), /Invalid resource sample/);
  const legacy = report(at);
  legacy.identity.installation = 'fixture:MixedCase';
  assert.equal(validateResourceReport(legacy, 'fixture:MixedCase', at).identity.installation, 'fixture:MixedCase');
  assert.throws(() => validateResourceReport(legacy, 'fixture:mixedcase', at), /Invalid resource identity/);
  legacy.identity.installation = 'fixture:\0';
  assert.throws(() => validateResourceReport(legacy, legacy.identity.installation, at), /Invalid resource identity/);
  hub.stop();
});

test('reports arriving during a write preserve newer minutes without starving other workers', async () => {
  let at = Date.now();
  let release!: () => void;
  const batches: string[][] = [];
  const hub = new ResourceMonitoringHub(
    'test/rivet',
    {
      write: async (reports) => {
        batches.push(reports.map((r) => r.identity.incarnation));
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      cleanup: async () => {},
      history: async (period, now) => unavailableResourceHistory(period, now),
    },
    () => at,
  );
  for (let i = 0; i < 40; i++) hub.ingest(report(at, `worker-${i}`));
  const first = hub.flush();
  at += 5000;
  for (let i = 0; i < 32; i++) hub.ingest(report(at, `worker-${i}`));
  release();
  await first;
  at += 30000;
  const second = hub.flush();
  assert.deepEqual(
    batches[1]!.slice(0, 8),
    Array.from({ length: 8 }, (_, i) => `worker-${i + 32}`),
  );
  assert.equal(
    Math.max(...hub.pending.get('worker-0')!.buckets.flatMap((b) => b.samples.map((s) => s.at))),
    at - 30000,
  );
  release();
  await second;
  hub.stop();
});

test('retention failure never backs off successful resource writes', async () => {
  let at = Date.now(),
    writes = 0,
    cleanups = 0;
  const hub = new ResourceMonitoringHub(
    'test/rivet',
    {
      write: async () => {
        writes++;
      },
      cleanup: async () => {
        cleanups++;
        throw Error('retention unavailable');
      },
      history: async (period, now) => ({ ...unavailableResourceHistory(period, now), available: true, error: null }),
    },
    () => at,
  );
  for (let i = 0; i < 3; i++) {
    hub.ingest(report(at));
    await hub.flush();
    assert.equal(writes, i + 1);
    assert.equal((await hub.history('1h')).error, null);
    at += 30000;
  }
  assert.equal(cleanups, 2, 'Retention attempts keep their own one-minute bound');
  hub.stop();
});

test('bounded history does not double-count omitted cached instances', async () => {
  const at = Date.now(),
    source = report(at),
    stats = resourceStatistics();
  const instance: ResourceInstanceHistory = {
    identity: source.identity,
    allocation: source.allocation,
    firstSampleAt: at,
    lastSampleAt: at,
    latest: source.buckets[0]!.samples[0]!,
    droppedSamples: 0,
    cpu: stats,
    memory: stats,
    workingSet: stats,
    points: [],
  };
  const hub = new ResourceMonitoringHub(
    'test/rivet',
    {
      write: async () => {},
      cleanup: async () => {},
      history: async (period, now) => ({
        ...unavailableResourceHistory(period, now),
        available: true,
        error: null,
        instances: Array.from({ length: 64 }, (_, i) => ({
          ...instance,
          identity: { ...instance.identity, incarnation: `visible-${i}` },
        })),
        omittedInstances: 10,
      }),
    },
    () => at,
  );
  for (let i = 0; i < 10; i++) hub.ingest(report(at, `omitted-${i}`));
  const result = await hub.history('1h');
  assert.equal(result.instances.length, 64);
  assert.equal(result.omittedInstances, 10, 'The same omitted histories may be present in both database and cache');
  hub.stop();
});
