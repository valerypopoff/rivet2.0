import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { allocateDistinctTestPorts } from './helpers/http-server-harness.js';
import {
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
} from '../routes/workflows/managed/schema-migrations.js';
import { ResourceMonitoringStore } from '../resource-monitoring/store.js';
import { validateResourceReport } from '../resource-monitoring/service.js';
import { summarizeResourceSamples } from '../resource-monitoring/history.js';
import type { ResourceReport } from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';

const docker = (...args: string[]) =>
  execFileSync('docker', [...(process.platform === 'win32' ? ['--context', 'desktop-linux'] : []), ...args], {
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
const name = `rivet-resource-${randomUUID()}`;
const [port] = await allocateDistinctTestPorts(1);
let pool: Pool | undefined;
try {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'rivet.dev/test=resource-monitoring',
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=rivet_resources',
    'postgres:16-alpine',
  );
  pool = new Pool({
    connectionString: `postgresql://postgres@127.0.0.1:${port}/rivet_resources`,
    connectionTimeoutMillis: 1000,
    max: 2,
  });
  pool.on('error', () => {});
  const readinessDeadline = Date.now() + 45000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() >= readinessDeadline) throw error;
      await delay(100);
    }
  }
  await migrateManagedWorkflowSchema(pool);
  await verifyManagedWorkflowSchema(pool);
  const minute = Math.floor(Date.now() / 60000) * 60000,
    now = minute + 25000;
  const make = (id: string, values: number[]): ResourceReport => ({
    identity: { installation: 'test/rivet', incarnation: id, name: id, source: 'cgroup-v2', role: 'execution' },
    allocation: {
      cpuRequestMillicores: 2000,
      memoryRequestBytes: 4 * 1024 ** 3,
      cpuLimitMillicores: null,
      memoryLimitBytes: null,
    },
    droppedSamples: 0,
    buckets: [
      {
        at: minute,
        revision: 3,
        samples: values.map((cpu, i) => ({
          at: minute + 1000 + i * 5000,
          durationMs: 5000,
          cpuMillicores: cpu,
          memoryBytes: cpu * 1024,
          workingSetBytes: cpu * 512,
          lifetimeMemoryPeakBytes: 3000 * 1024,
          activeRuns: 1,
          runLimit: 32,
        })),
      },
    ],
  });
  const a = make('a', [100, 1000, 100]),
    b = make('b', [1000, 100, 100]);
  validateResourceReport(a, 'test/rivet', now);
  const store = new ResourceMonitoringStore(pool, 'test/rivet');
  await store.write([a, b]);
  await store.write([a, b]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM resource_monitoring_minutes')).rows[0].n, 2);
  const history = await store.history('1h', now);
  assert.equal(history.instances.length, 2);
  assert.equal(history.instances[0]!.cpu.average, 400);
  assert.equal(history.pools[0]!.cpu.peak, 1100, 'Independent maxima must not be summed');
  assert.equal(history.instances[0]!.cpu.peak, 1000);
  const restored = await new ResourceMonitoringStore(pool, 'test/rivet').history('1h', now);
  assert.deepEqual(restored, history);
  assert.equal((await new ResourceMonitoringStore(pool, 'foreign/rivet').history('7d', now)).instances.length, 0);
  const newer = make('a', [50, 50, 50]);
  newer.buckets[0]!.revision = 4;
  await store.write([newer]);
  await store.write([a]);
  assert.equal((await store.history('1h', now)).instances.find((i) => i.identity.incarnation === 'a')!.cpu.average, 50);
  const archived = make('archived', [100, 300, 200]);
  archived.identity.role = 'control';
  archived.buckets[0]!.at -= 120000;
  for (const sample of archived.buckets[0]!.samples) sample.at -= 120000;
  archived.buckets[0]!.samples[0]!.durationMs = 0;
  archived.buckets[0]!.samples[0]!.cpuMillicores = null;
  archived.buckets[0]!.samples[0]!.memoryBytes = 10_000_000;
  await store.write([archived]);
  const summarized = (await store.history('1h', now)).instances.find((i) => i.identity.incarnation === 'archived')!;
  assert.equal(summarized.memory.peak, 10_000_000, 'An initial gauge can be a peak without known time coverage');
  await pool.query("UPDATE resource_monitoring_minutes SET summary='{}' WHERE incarnation='archived'");
  const fromSamples = (await store.history('1h', now)).instances.find((i) => i.identity.incarnation === 'archived')!;
  for (const field of ['cpu', 'memory', 'workingSet'] as const) {
    assert.equal(summarized[field].average, fromSamples[field].average);
    assert.equal(summarized[field].coverageMs, fromSamples[field].coverageMs);
    assert.equal(summarized[field].peak, fromSamples[field].peak);
    assert.ok(Math.abs(summarized[field].p95! - fromSamples[field].p95!) < 0.000001);
  }
  const outdated = now - 8 * 86400000;
  await pool.query(
    `INSERT INTO resource_monitoring_minutes(installation,incarnation,bucket_at,revision,samples)
    SELECT 'test/rivet','expired', $1::bigint-n*60000,1,'[]' FROM generate_series(1,600) n`,
    [outdated],
  );
  await store.cleanup(now);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM resource_monitoring_minutes WHERE incarnation='expired'")).rows[0]
      .n,
    100,
  );
  await store.cleanup(now);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM resource_monitoring_minutes WHERE incarnation='expired'")).rows[0]
      .n,
    0,
  );
  const blocker = await pool.connect();
  let blockedWrite: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN; LOCK resource_monitoring_instances IN ACCESS EXCLUSIVE MODE');
    blockedWrite = store.write([newer]).then(
      () => null,
      (error: { code?: string }) => error,
    );
    const result = await Promise.race([blockedWrite, delay(4500).then(() => null)]);
    assert.ok(
      result && ['55P03', '57014'].includes((result as { code?: string }).code ?? ''),
      'Contended telemetry writes must hit their server-side deadline',
    );
    assert.equal((await pool.query('SELECT 1 AS ready')).rows[0].ready, 1);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await blockedWrite;
  }
  await store.write([newer]);
  const times: Record<string, number> = {};
  if (process.argv.includes('--measure')) {
    const workers = Number(process.argv.find((arg) => arg.startsWith('--workers='))?.slice('--workers='.length) ?? 2);
    assert.ok(Number.isInteger(workers) && workers >= 2 && workers <= 16, 'Use --workers=2..16 for the local fixture');
    await pool.query(
      `INSERT INTO resource_monitoring_instances
      SELECT installation,'worker-'||n,role,'worker-'||n,source,allocation,first_at,last_at,latest,dropped_samples
      FROM resource_monitoring_instances CROSS JOIN generate_series(3,$1::int) n
      WHERE installation='test/rivet' AND incarnation='a'`,
      [workers],
    );
    // Seven days, twelve observations per minute. Never use an
    // operator URL or an existing database for this workload.
    await pool.query(
      `INSERT INTO resource_monitoring_minutes(installation,incarnation,bucket_at,revision,samples,summary)
      SELECT 'test/rivet',owner,$1::bigint-n*60000,100,
        (SELECT jsonb_agg(jsonb_build_object('at',$1::bigint-n*60000+k*5000,
          'durationMs',5000,'cpuMillicores',CASE WHEN owner='a' THEN 200+k*10 ELSE 300+k*20 END,
          'memoryBytes',536870912+k*1048576,'workingSetBytes',400000000,'lifetimeMemoryPeakBytes',1073741824,
          'activeRuns',k%8,'runLimit',32)) FROM generate_series(0,11) k),
        CASE WHEN owner='a' THEN $3::jsonb ELSE $4::jsonb END
      FROM generate_series(1,10080) n CROSS JOIN
        (SELECT CASE WHEN x=1 THEN 'a' WHEN x=2 THEN 'b' ELSE 'worker-'||x END AS owner FROM generate_series(1,$2::int) x) v
      ON CONFLICT(installation,incarnation,bucket_at) DO UPDATE SET samples=EXCLUDED.samples,revision=EXCLUDED.revision`,
      [
        minute,
        workers,
        ...[true, false].map((first) =>
          JSON.stringify(
            summarizeResourceSamples(
              Array.from({ length: 12 }, (_, k) => ({
                durationMs: 5000,
                cpuMillicores: first ? 200 + k * 10 : 300 + k * 20,
                memoryBytes: 536870912 + k * 1048576,
                workingSetBytes: 400000000,
              })),
            ),
          ),
        ),
      ],
    );
    await pool.query("UPDATE resource_monitoring_instances SET first_at=$1 WHERE installation='test/rivet'", [
      minute - 10080 * 60000,
    ]);
  }
  for (const period of ['1h', '24h', '7d'] as const) {
    const start = performance.now();
    const view = await store.history(period, now);
    times[period] = performance.now() - start;
    assert.ok(view.instances.every((i) => i.points.length <= 338));
    assert.ok(JSON.stringify(view).length < 5 * 1024 * 1024, 'Historical response exceeded its bounded budget');
  }
  console.log(
    JSON.stringify({
      success: true,
      idempotent: true,
      restartHistory: true,
      scope: true,
      alignedPoolPeak: true,
      boundedRetention: true,
      queryMilliseconds: times,
    }),
  );
} catch (error) {
  try {
    console.error(docker('logs', '--tail', '40', name));
  } catch {
    /* Preserve the original failure. */
  }
  throw error;
} finally {
  await pool?.end();
  try {
    docker('rm', '-f', '-v', name);
  } catch (error) {
    if (!/No such (container|object)/i.test(String((error as { stderr?: unknown }).stderr))) throw error;
  }
}
