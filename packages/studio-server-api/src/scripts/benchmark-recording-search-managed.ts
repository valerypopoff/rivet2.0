/** Disposable, loopback-only PostgreSQL + HTTP + compiled extraction benchmark. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createManagedWorkflowRecordingService } from '../routes/workflows/managed/recordings.js';
import { prepareManagedTextArtifact } from '../routes/workflows/managed/artifact-descriptor.js';
import { migrateManagedWorkflowSchema } from '../routes/workflows/managed/schema-migrations.js';
import { queryRows } from '../routes/workflows/managed/db.js';
import * as mappers from '../routes/workflows/managed/mappers.js';
import type { ManagedWorkflowContext } from '../routes/workflows/managed/context.js';
import { workflowRecordingInputCache } from '../routes/workflows/recording-input-cache.js';
import { disposeWorkflowRecordingInputExtractor } from '../routes/workflows/recording-input-extractor.js';
import { configureStudioMetrics } from '../metrics.js';
import {
  RECORDING_INPUT_CONCURRENT_READS,
  RECORDING_INPUT_FILTER_CONTINUATION_BUDGET_MS,
  matchesWorkflowRecordingInputFilter,
} from '../routes/workflows/recording-input-filter.js';
import { extractWorkflowRecordingInputFromSource } from '../routes/workflows/recording-input-source.js';

type RecordingPage = Awaited<
  ReturnType<ReturnType<typeof createManagedWorkflowRecordingService>['listWorkflowRecordingRunsPage']>
>;

if (import.meta.url.endsWith('.ts')) throw new Error('Build the API first: this benchmark requires compiled workers.');
const count = Number(process.env.RIVET_RECORDING_BENCH_COUNT ?? 800);
const inputKiB = Number(process.env.RIVET_RECORDING_BENCH_INPUT_KIB ?? 64);
const readDelayMs = Number(process.env.RIVET_RECORDING_BENCH_READ_MS ?? 10);
const scenario = process.env.RIVET_RECORDING_BENCH_SCENARIO ?? 'recent';
const status = process.env.RIVET_RECORDING_BENCH_STATUS ?? 'all';
if (
  !['recent', 'sparse', 'dense', 'absent'].includes(scenario) ||
  !['all', 'failed'].includes(status) ||
  ![count, inputKiB, readDelayMs].every(Number.isSafeInteger) ||
  count < 2 ||
  count > 2500 ||
  inputKiB < 1 ||
  inputKiB > 256 ||
  count * inputKiB > 160 * 1024 ||
  readDelayMs < 0 ||
  readDelayMs > 100
)
  throw new Error('Benchmark fixture exceeds its local resource bounds.');
const matches = (index: number) =>
  scenario === 'dense' ||
  (scenario === 'recent' && index === 0) ||
  (scenario === 'sparse' && ((index > 0 && index % 35 === 0) || index === count - 1));
const failed = (index: number) => index % 7 === 0 || index % 11 === 0;
const metrics = configureStudioMetrics('control', { RIVET_METRICS_ENABLED: 'true' });
const extractionTotals = () => {
  const totals: Record<string, number> = {};
  for (const line of metrics.render().split('\n')) {
    const match = /^rivet_recording_input_extraction_seconds_sum\{.*stage="([^"]+)".*\} (\S+)$/.exec(line);
    if (match) totals[match[1]!] = Number(match[2]) * 1000;
  }
  return totals;
};
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();
let container: string | undefined;
let pool: Pool | undefined;
let server: ReturnType<typeof createServer> | undefined;
try {
  container = docker(
    'run',
    '--rm',
    '-d',
    '--name',
    `rivet-search-bench-${randomUUID()}`,
    '--memory=1g',
    '--cpus=2',
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:16.8-alpine',
  );
  const port = docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  );
  pool = new Pool({
    connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`,
    max: 2,
    connectionTimeoutMillis: 1000,
  });
  const database = pool;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await database.query('SELECT 1');
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
  await migrateManagedWorkflowSchema(database, { logger: { log() {}, warn() {} } });
  const artifacts = new Map<string, Uint8Array>();
  const keys: string[] = [];
  const sizes: number[] = [];
  const payload = 'local synthetic payload '.repeat(Math.ceil((inputKiB * 1024) / 24)).slice(0, inputKiB * 1024);
  for (let i = 0; i < count; i++) {
    const text = JSON.stringify({
      strings: {},
      recording: {
        events: [
          {
            type: 'start',
            data: {
              inputs: { input: { value: { request_id: matches(i) ? 'request-0' : `other-${i}`, payload } } },
            },
          },
        ],
      },
    });
    const artifact = await prepareManagedTextArtifact(`recording-${i}`, text, true);
    artifacts.set(artifact.descriptor.key, artifact.bytes);
    keys.push(artifact.descriptor.key);
    sizes.push(Buffer.byteLength(text));
  }
  await database.query(
    `INSERT INTO workflow_recordings (
    recording_id, workflow_id, source_project_name, source_project_relative_path, created_at,
    run_kind, status, duration_ms, endpoint_name_at_execution, execution_surface, correlation_id,
    recording_blob_key, replay_project_blob_key, recording_uncompressed_bytes, recording_compressed_bytes
  ) SELECT 'recording-' || i, 'project-' || (i % 5), 'Fixture', 'Fixture.rivet-project',
    '2026-01-01'::timestamptz - i * interval '1 microsecond', 'published',
    CASE WHEN i % 7 = 0 THEN 'failed' WHEN i % 11 = 0 THEN 'suspicious' ELSE 'succeeded' END, 1, 'fixture', 'workflow_endpoint',
    'benchmark-correlation-' || lpad(i::text, 16, '0'), ($2::text[])[i+1], ($2::text[])[i+1],
    ($3::bigint[])[i+1], ($4::bigint[])[i+1]
    FROM generate_series(0, $1::int - 1) i`,
    [count, keys, sizes, keys.map((key) => artifacts.get(key)!.byteLength)],
  );
  await database.query(
    `INSERT INTO workflow_recordings (
    recording_id, workflow_id, source_project_name, source_project_relative_path,
    run_kind, status, duration_ms, endpoint_name_at_execution, execution_surface,
    correlation_id, recording_blob_key, replay_project_blob_key
  ) SELECT 'child-' || i, 'child-project', 'Fixture', 'Fixture.rivet-project', 'published',
    'succeeded', 1, 'fixture', 'subgraph_project',
    'benchmark-correlation-' || lpad((i % $1::int)::text, 16, '0'), 'unused', 'unused'
    FROM generate_series(0, $1::int * 4 - 1) i`,
    [count],
  );
  await database.query('ANALYZE workflow_recordings');
  const emptyStats = () => ({
    queries: 0,
    counts: 0,
    decoratedQueries: 0,
    sqlMs: 0,
    countSqlMs: 0,
    candidateSqlMs: 0,
    matchSqlMs: 0,
    reads: 0,
    canceledReads: 0,
    bytes: 0,
    artifactReadMs: 0,
  });
  let stats = emptyStats();
  let blockReads = false;
  let readStarted: (() => void) | undefined;
  let searchSettled: (() => void) | undefined;
  const measuredRows: typeof queryRows = async (client, sql, values, ...options) => {
    const start = performance.now();
    stats.queries++;
    if (sql.includes('COUNT(*)::int')) stats.counts++;
    if (sql.includes('has_sub_runs')) stats.decoratedQueries++;
    try {
      return await queryRows(client, sql, values, ...options);
    } finally {
      const duration = performance.now() - start;
      stats.sqlMs += duration;
      stats[
        sql.includes('COUNT(*)::int')
          ? 'countSqlMs'
          : sql.includes('WITH recording_matches')
            ? 'matchSqlMs'
            : 'candidateSqlMs'
      ] += duration;
    }
  };
  const context = {
    pool: database,
    initialize: async () => {},
    revisions: {},
    mappers,
    db: {
      queryRows: measuredRows,
      queryOne: async (client: Pool, sql: string, values: unknown[], signal?: AbortSignal) =>
        (await measuredRows(client, sql, values, signal))[0] ?? null,
    },
    blobStore: {
      getBytes: async (key: string, options?: { signal?: AbortSignal }) => {
        stats.reads++;
        const started = performance.now();
        readStarted?.();
        try {
          if (blockReads || readDelayMs)
            await delay(blockReads ? 5000 : readDelayMs, undefined, { signal: options?.signal });
          const bytes = artifacts.get(key);
          assert.ok(bytes, 'Unknown fixture artifact');
          stats.bytes += bytes.byteLength;
          return bytes;
        } catch (error) {
          if (options?.signal?.aborted) stats.canceledReads++;
          throw error;
        } finally {
          stats.artifactReadMs += performance.now() - started;
        }
      },
    },
  } as unknown as ManagedWorkflowContext;
  const service = createManagedWorkflowRecordingService({ context });
  server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const url = new URL(req.url!, 'http://localhost');
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const after = url.searchParams.get('after') ?? undefined;
      const page = await service.listWorkflowRecordingRunsPage(
        url.searchParams.get('project') ?? '',
        1,
        cursor || after ? 100 : 20,
        status as 'all' | 'failed',
        { path: '$.request_id', operator: '==', value: url.searchParams.get('value')! },
        cursor,
        controller.signal,
        after,
      );
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(page));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    } finally {
      searchSettled?.();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const reports = [];
  for (const project of ['', 'project-0']) {
    // Reference results use ordinary full metadata and full-input extraction,
    // bypassing both the optimized candidate query and the input cache.
    const reference = new Map([
      ['request-0', [] as string[]],
      ['absent', [] as string[]],
    ]);
    for (let pageNumber = 1; ; pageNumber++) {
      const page = await service.listWorkflowRecordingRunsPage(
        project,
        pageNumber,
        100,
        status as 'all' | 'failed',
        null,
        0,
        undefined,
        undefined,
        false,
        'roots',
      );
      for (const row of page.runs) {
        const index = Number(row.id.slice('recording-'.length));
        assert.ok(Number.isInteger(index) && index >= 0 && index < count);
        const input = extractWorkflowRecordingInputFromSource({
          kind: 'artifact',
          bytes: artifacts.get(keys[index]!)!,
          encoding: 'gzip',
          decodedBytes: sizes[index],
        });
        for (const [value, ids] of reference) {
          if (
            input?.exists &&
            matchesWorkflowRecordingInputFilter(input.value, { path: '$.request_id', operator: '==', value })
          )
            ids.push(row.id);
        }
      }
      if (!page.hasMore) break;
    }
    workflowRecordingInputCache.clear();
    for (const phase of ['cold', 'repeat', 'changed-value'] as const) {
      stats = emptyStats();
      const before = workflowRecordingInputCache.diagnostics;
      const extractionBefore = extractionTotals();
      const value = phase === 'changed-value' ? 'absent' : 'request-0';
      const ids: string[] = [];
      let cursor = 0,
        after: string | undefined,
        requests = 0,
        analyzedRuns = 0,
        firstResultMs: number | undefined,
        firstPageMs: number | undefined;
      let peakRss = process.memoryUsage().rss;
      const sample = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 10);
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const start = performance.now();
      const cpuStart = process.cpuUsage();
      const signal = AbortSignal.timeout(60_000);
      try {
        do {
          const url: URL = new URL(`http://127.0.0.1:${address.port}/`);
          url.searchParams.set('value', value);
          url.searchParams.set('project', project);
          url.searchParams.set('cursor', String(cursor));
          if (after) url.searchParams.set('after', after);
          const response: Response = await fetch(url, { signal });
          const page = (await response.json()) as RecordingPage;
          assert.equal(response.status, 200, JSON.stringify(page));
          requests++;
          ids.push(...page.runs.map((run) => run.id));
          analyzedRuns = Math.max(analyzedRuns, page.inputSearchAnalyzedRuns ?? 0);
          if (ids.length && firstResultMs == null) firstResultMs = performance.now() - start;
          if (ids.length >= 20 && firstPageMs == null) firstPageMs = performance.now() - start;
          if (!page.hasMore) break;
          assert.ok(page.nextInputCursor! > cursor);
          cursor = page.nextInputCursor!;
          after = page.nextInputAfter;
        } while (true);
        const eligible = Array.from({ length: count }, (_, i) => i).filter(
          (i) => (!project || i % 5 === 0) && (status === 'all' || failed(i)),
        );
        assert.deepEqual(ids, reference.get(value), 'optimized results must match the full-input reference path');
        assert.deepEqual(
          ids,
          eligible.filter((i) => value === 'request-0' && matches(i)).map((i) => `recording-${i}`),
        );
        assert.equal(analyzedRuns, eligible.length);
        assert.equal(stats.counts, 1, 'continuations must not recount history');
        if (phase !== 'cold') assert.equal(stats.reads, 0, 'covered repeats must use retained projections');
        const extractionAfter = extractionTotals();
        reports.push({
          scope: project ? 'one-project' : 'any',
          phase,
          requests,
          firstResultMs,
          firstPageMs: firstPageMs ?? null,
          resultCount: ids.length,
          analyzedRuns,
          extractionMs: Object.fromEntries(
            Object.entries(extractionAfter).map(([key, value]) => [key, value - (extractionBefore[key] ?? 0)]),
          ),
          completedMs: performance.now() - start,
          ...stats,
          before,
          after: workflowRecordingInputCache.diagnostics,
          peakRssBytes: peakRss,
          cpuMicros: process.cpuUsage(cpuStart),
          eventLoopP99Ms: loop.percentile(99) / 1e6,
        });
      } finally {
        clearInterval(sample);
        loop.disable();
      }
    }
  }
  // Hold one real artifact read until cancellation, independently of fixture
  // speed, so Stop is checked without a timing race or a production request.
  workflowRecordingInputCache.clear();
  stats = emptyStats();
  blockReads = true;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const settled = new Promise<void>((resolve) => {
    searchSettled = resolve;
  });
  const cancel = new AbortController();
  const request = fetch(`http://127.0.0.1:${address.port}/?value=absent`, {
    signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(10_000)]),
  }).then(
    () => {
      throw new Error('The held request completed before Stop');
    },
    (error: unknown) => error,
  );
  await Promise.race([
    started,
    request.then((error) => {
      throw error;
    }),
  ]);
  const stopStartedAt = performance.now();
  cancel.abort();
  assert.equal(((await request) as Error).name, 'AbortError');
  const clientStopMs = performance.now() - stopStartedAt;
  await settled;
  const settlementDeadline = Date.now() + 5000;
  while (workflowRecordingInputCache.diagnostics.activeLoads && Date.now() < settlementDeadline) await delay(1);
  assert.ok(stats.canceledReads > 0, 'Stop must reach the admitted artifact read');
  assert.equal(workflowRecordingInputCache.diagnostics.activeLoads, 0);
  assert.equal(workflowRecordingInputCache.diagnostics.queuedLoads, 0);
  const stop = { clientStopMs, serverSettledMs: performance.now() - stopStartedAt, canceledReads: stats.canceledReads };
  console.log(
    JSON.stringify(
      {
        node: process.version,
        count,
        inputKiB,
        readDelayMs,
        scenario,
        status,
        stop,
        concurrentReads: RECORDING_INPUT_CONCURRENT_READS,
        continuationBudgetMs: RECORDING_INPUT_FILTER_CONTINUATION_BUDGET_MS,
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  disposeWorkflowRecordingInputExtractor();
  if (pool) await pool.end();
  if (container) docker('rm', '-f', container);
}
