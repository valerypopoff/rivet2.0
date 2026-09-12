import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { gzipSync, gunzip, deflateRawSync, inflateRawSync } from 'node:zlib';
import { serialize, deserialize } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';
import {
  WorkflowRecordingInputCache,
  getFilesystemRecordingInputCacheKey,
} from '../routes/workflows/recording-input-cache.js';
import {
  disposeWorkflowRecordingInputExtractor,
  WorkflowRecordingInputExtractor,
} from '../routes/workflows/recording-input-extractor.js';
import {
  filterRecordingInputWindows,
  filterRowsByRecordingInputPage,
  createWorkflowRecordingInputAfter,
  parseWorkflowRecordingInputAfter,
  RECORDING_INPUT_FILTER_SCAN_BUDGET_MS,
} from '../routes/workflows/recording-input-filter.js';
import {
  replaceWorkflowRecordingIndex,
  resetWorkflowRecordingDatabaseForTests,
  listWorkflowRecordingRunRowsForWorkflowWindow,
  explainWorkflowRecordingWindow,
  type WorkflowRecordingRunRow,
} from '../routes/workflows/recordings-db.js';

const gunzipAsync = promisify(gunzip);
const scope = {
  workflowId: 'benchmark',
  statusFilter: 'all' as const,
  filter: { path: '$.requestId', operator: '==' as const, value: 'needle' },
};
const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!,
    value = process.argv[i + 1];
  if (
    ![
      '--scenario',
      '--recordings',
      '--payload-kib',
      '--page-size',
      '--read-latency-ms',
      '--http-latency-ms',
      '--extraction-kib',
      '--input-kib',
      '--cache-mib',
      '--cache-entry-kib',
      '--cache-ttl-ms',
      '--repeat-delay-ms',
      '--initial-page-size',
    ].includes(key) ||
    value == null
  )
    throw new Error(`Unknown or incomplete benchmark option: ${key}`);
  flags.set(key, value);
}
function integer(name: string, fallback: number, minimum = 1): number {
  const value = flags.get(name) ?? String(fallback);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum)
    throw new Error(`Invalid ${name}`);
  return Number(value);
}
const count = integer('--recordings', 250),
  payloadKiB = integer('--payload-kib', 32),
  pageSize = integer('--page-size', 100);
const inputKiB = integer('--input-kib', 0, 0),
  cacheMiB = integer('--cache-mib', 32),
  cacheEntryKiB = integer('--cache-entry-kib', 1024),
  cacheTtlMs = integer('--cache-ttl-ms', 300000),
  repeatDelayMs = integer('--repeat-delay-ms', 0, 0),
  initialPageSize = integer('--initial-page-size', 20);
const readLatencyMs = integer('--read-latency-ms', 0, 0),
  httpLatencyMs = integer('--http-latency-ms', 0, 0);
const extractionKiB = integer('--extraction-kib', 16384),
  scenario = flags.get('--scenario') ?? 'recent';
if (
  !['recent', 'dense', 'sparse', 'absent'].includes(scenario) ||
  pageSize > 100 ||
  initialPageSize > 100 ||
  cacheMiB > 512 ||
  cacheEntryKiB > 8192 ||
  inputKiB > 8192 ||
  count * (payloadKiB + inputKiB) > 512 * 1024 ||
  extractionKiB > 64 * 1024
)
  throw new Error('Invalid scenario/page size or fixture exceeds safety limit.');
const matches = (index: number) =>
  scenario === 'dense' || (scenario === 'recent' && index === 0) || (scenario === 'sparse' && index % 50 === 49);

function fixtureText(index: number, kib: number): string {
  let seed = index + 123;
  const chars = new Uint8Array(kib * 1024);
  for (let offset = 0; offset < chars.length; offset++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    chars[offset] = index % 2 ? 33 + ((seed >>> 24) % 90) : 120;
  }
  return Buffer.from(chars).toString('ascii');
}

function artifact(index: number, kib: number): Buffer {
  return gzipSync(
    JSON.stringify({
      recording: {
        events: [
          {
            type: 'start',
            data: {
              inputs: {
                input: {
                  value: {
                    requestId: matches(index) ? '$STRING:request' : 'other',
                    ...(inputKiB ? { payload: fixtureText(index, inputKiB) } : {}),
                  },
                },
              },
            },
          },
        ],
      },
      assets: { unrelated: fixtureText(index, kib) },
      strings: { request: 'needle' },
    }),
  );
}

async function measure(
  rows: WorkflowRecordingRunRow[],
  mode: 'serialized-main' | 'artifact-worker',
  pagination: 'single-window' | 'multi-window',
) {
  disposeWorkflowRecordingInputExtractor();
  const blankStats = () => ({
    queries: 0,
    reads: 0,
    completedReads: 0,
    abortedReads: 0,
    lookups: 0,
    decompressionMs: 0,
    parseMs: 0,
    queueAndTransferMs: 0,
  });
  let stats = blankStats();
  const cache = new WorkflowRecordingInputCache({
    maxBytes: cacheMiB * 1024 * 1024,
    maxEntryBytes: cacheEntryKiB * 1024,
    ttlMs: cacheTtlMs,
    onExtractionTiming: (timing) => {
      stats.decompressionMs += timing.decompressionMs;
      stats.parseMs += timing.parseAndExtractMs;
      stats.queueAndTransferMs += timing.workerQueueAndTransferMs;
    },
  });
  const loadWindow = async (after: string | undefined, offset: number, limit: number) => {
    stats.queries++;
    return listWorkflowRecordingRunRowsForWorkflowWindow(scope.workflowId, {
      statusFilter: 'all',
      after: parseWorkflowRecordingInputAfter(after, scope),
      offset: after ? 0 : offset,
      limit,
    });
  };
  const read = async (row: WorkflowRecordingRunRow, signal: AbortSignal) => {
    stats.lookups++;
    const identity = await fs.stat(row.bundlePath);
    return cache.getOrLoad(
      getFilesystemRecordingInputCacheKey({
        recordingPath: row.bundlePath,
        encoding: 'gzip',
        size: identity.size,
        mtimeMs: identity.mtimeMs,
      }),
      async (loadSignal) => {
        stats.reads++;
        try {
          if (readLatencyMs) await delay(readLatencyMs, undefined, { signal: loadSignal });
          const bytes = await fs.readFile(row.bundlePath, { signal: loadSignal });
          stats.completedReads++;
          if (mode === 'artifact-worker') return { kind: 'artifact', bytes, encoding: 'gzip' };
          const start = performance.now(),
            serializedRecording = (await gunzipAsync(bytes)).toString('utf8');
          stats.decompressionMs += performance.now() - start;
          return { kind: 'serialized', serializedRecording };
        } catch (error) {
          if (loadSignal.aborted) stats.abortedReads++;
          throw error;
        }
      },
      signal,
      row.recordingCompressedBytes * 2 + row.recordingUncompressedBytes * 4,
    );
  };
  const getInputAfter = (row: WorkflowRecordingRunRow, cursor: number) =>
    createWorkflowRecordingInputAfter(
      {
        createdAt: row.createdAt,
        recordingId: row.id,
        legacyCursor: cursor,
      },
      scope,
    );
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const url = new URL(req.url!, 'http://localhost'),
        inputCursor = Number(url.searchParams.get('cursor') ?? 0);
      const inputAfter = url.searchParams.get('after') || undefined;
      const batchSize = inputCursor === 0 && !inputAfter ? initialPageSize : pageSize;
      const start = performance.now();
      const page =
        pagination === 'multi-window'
          ? await filterRecordingInputWindows(scope.filter, loadWindow, read, {
              inputCursor,
              inputAfter,
              pageSize: batchSize,
              getInputAfter,
              signal: controller.signal,
            })
          : await (async () => {
              const size = Math.max(24, batchSize),
                fetched = await loadWindow(inputAfter, inputCursor, size + 1);
              return filterRowsByRecordingInputPage(fetched.slice(0, size), scope.filter, read, {
                cursor: 0,
                cursorBase: inputCursor,
                pageSize: batchSize,
                hasMoreCandidates: fetched.length > size,
                isInitialSearch: inputCursor === 0,
                probeFirstCandidate: inputCursor === 0,
                scanBudgetMs: Math.max(0, RECORDING_INPUT_FILTER_SCAN_BUDGET_MS - (performance.now() - start)),
                getInputAfter,
                signal: controller.signal,
              });
            })();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(page));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port,
    reports = [];
  try {
    for (const phase of ['cold', 'warm', 'concurrent-cold']) {
      if (phase === 'warm' && repeatDelayMs) await delay(repeatDelayMs);
      if (phase === 'concurrent-cold') cache.clear();
      const cacheBefore = cache.diagnostics;
      stats = blankStats();
      const start = performance.now(),
        eventLoop = monitorEventLoopDelay({ resolution: 10 });
      eventLoop.enable();
      let peakRssBytes = process.memoryUsage().rss;
      const sampler = setInterval(() => {
        peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      }, 5);
      let requests = 0;
      let firstResultMs: number | null = null,
        firstPageMs: number | null = null;
      const ids: string[] = [];
      try {
        const search = async () => {
          let cursor = 0,
            after = '';
          const searchIds: string[] = [];
          do {
            if (httpLatencyMs) await delay(httpLatencyMs);
            const response = await fetch(
              `http://127.0.0.1:${port}/search?cursor=${cursor}&after=${encodeURIComponent(after)}`,
            );
            if (!response.ok) throw new Error(await response.text());
            const page = (await response.json()) as Awaited<
              ReturnType<typeof filterRecordingInputWindows<WorkflowRecordingRunRow>>
            >;
            requests++;
            ids.push(...page.rows.map((row) => row.id));
            searchIds.push(...page.rows.map((row) => row.id));
            if (ids.length && firstResultMs == null) firstResultMs = performance.now() - start;
            if (searchIds.length >= initialPageSize && firstPageMs == null) firstPageMs = performance.now() - start;
            if (!page.hasMore) break;
            assert.ok(page.nextInputCursor! > cursor, 'cursor must advance');
            cursor = page.nextInputCursor!;
            after = page.nextInputAfter!;
          } while (true);
          assert.deepEqual(
            searchIds,
            rows.filter((_row, index) => matches(index)).map((row) => row.id),
          );
        };
        await Promise.all(Array.from({ length: phase === 'concurrent-cold' ? 2 : 1 }, search));
        reports.push({
          mode,
          pagination,
          phase,
          requests,
          resultCount: ids.length,
          firstResultMs,
          firstPageMs,
          completedMs: performance.now() - start,
          ...stats,
          cacheBefore,
          cacheAfter: cache.diagnostics,
          peakRssBytes,
          eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
        });
      } finally {
        clearInterval(sampler);
        eventLoop.disable();
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return reports;
}

async function compareExtraction(bytes: Buffer, mode: string) {
  const child = fork(new URL('./recording-input-extraction-benchmark-worker.js', import.meta.url), [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Extraction benchmark timed out'));
      }, 60000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Extraction benchmark exited: ${code}`));
      });
      child.once('message', (message) => {
        clearTimeout(timeout);
        resolve({ mode, ...(message as object) });
      });
      child.send({ bytes, mode });
    });
  } finally {
    child.kill();
  }
}

async function main() {
  if (import.meta.url.endsWith('.ts')) throw new Error('Build the API first; benchmark requires compiled workers.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-input-benchmark-')),
    previousRoot = process.env.RIVET_APP_DATA_ROOT;
  process.env.RIVET_APP_DATA_ROOT = root;
  try {
    const rows: WorkflowRecordingRunRow[] = [];
    for (let index = 0; index < count; index++) {
      const bytes = artifact(index, payloadKiB),
        filePath = path.join(root, `${index}.gz`);
      await fs.writeFile(filePath, bytes);
      rows.push({
        id: `recording-${String(index).padStart(6, '0')}`,
        workflowId: scope.workflowId,
        createdAt: new Date(Date.UTC(2026, 0, 1) - index).toISOString(),
        runKind: 'published',
        status: 'succeeded',
        durationMs: 1,
        endpointNameAtExecution: 'benchmark',
        bundlePath: filePath,
        encoding: 'gzip',
        hasReplayDataset: false,
        recordingCompressedBytes: bytes.length,
        recordingUncompressedBytes: (payloadKiB + inputKiB) * 1024,
        projectCompressedBytes: 0,
        projectUncompressedBytes: 0,
        datasetCompressedBytes: 0,
        datasetUncompressedBytes: 0,
      });
    }
    await replaceWorkflowRecordingIndex(
      [
        {
          workflowId: scope.workflowId,
          sourceProjectMetadataId: 'benchmark',
          sourceProjectPath: 'benchmark',
          sourceProjectRelativePath: 'benchmark',
          sourceProjectName: 'Benchmark',
          updatedAt: rows[0]!.createdAt,
        },
      ],
      rows,
    );
    const measurements = [];
    for (const mode of ['serialized-main', 'artifact-worker'] as const)
      for (const pagination of ['single-window', 'multi-window'] as const) {
        measurements.push(...(await measure(rows, mode, pagination)));
      }
    disposeWorkflowRecordingInputExtractor();
    const extraction = [];
    for (const kib of new Set([32, extractionKiB]))
      for (const entropy of [0, 1]) {
        const bytes = artifact(entropy, kib),
          full = await compareExtraction(bytes, 'full'),
          tokenizer = await compareExtraction(bytes, 'tokenizer');
        assert.equal(full.error, undefined);
        assert.equal(tokenizer.error, undefined);
        assert.deepEqual(tokenizer.input, full.input);
        const { input: _fullInput, ...fullMetrics } = full;
        const { input: _tokenizerInput, ...tokenizerMetrics } = tokenizer;
        extraction.push({
          kib,
          entropy,
          compressedBytes: bytes.length,
          full: fullMetrics,
          tokenizer: tokenizerMetrics,
        });
      }
    const boundary = rows[Math.floor(rows.length * 0.8)]!;
    const queryPlans = await explainWorkflowRecordingWindow(scope.workflowId, {
      offset: 0,
      limit: 25,
      statusFilter: 'all',
      after: { createdAt: boundary.createdAt, recordingId: boundary.id },
    });
    const report = {
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      availableCpus: os.availableParallelism(),
      scenario,
      count,
      payloadKiB,
      inputKiB,
      pageSize,
      initialPageSize,
      cacheMiB,
      cacheEntryKiB,
      cacheTtlMs,
      repeatDelayMs,
      cacheCompression: compareCacheCompression(),
      workerPreparation: await compareWorkerPreparation(),
      readLatencyMs,
      httpLatencyMs,
      measurements,
      extraction,
      queryPlans,
      limits: [
        'Loopback HTTP adapter uses production SQLite query/scanner/cache but excludes application authentication.',
        'single-window comparison uses current cancellation and worker fixes, not a historical checkout.',
        'Search RSS is sampled process-wide; isolated extraction trials report OS peak RSS.',
        'Tokenizer is benchmark-only, not production-compatible for every duplicate-container/invalid-wrapper case.',
        'Run under a two-CPU container/VM for resource-constrained measurements.',
      ],
    };
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../artifacts/benchmarks',
    );
    await fs.mkdir(directory, { recursive: true });
    const reportPath = path.join(directory, `recording-input-search-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  } finally {
    disposeWorkflowRecordingInputExtractor();
    await resetWorkflowRecordingDatabaseForTests();
    if (previousRoot == null) delete process.env.RIVET_APP_DATA_ROOT;
    else process.env.RIVET_APP_DATA_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}

// CPU/retention comparison only: this does not change production cache encoding.
function compareCacheCompression() {
  return [0, 1].map((entropy) => {
    const value = { exists: true, value: { payload: fixtureText(entropy, Math.max(1, inputKiB)) } };
    const bytes = serialize(value);
    const encodeStarted = performance.now();
    const compressed = deflateRawSync(bytes, { level: 1 });
    const encodeMs = performance.now() - encodeStarted;
    const iterations = 100;
    let start = performance.now();
    for (let i = 0; i < iterations; i++) deserialize(bytes);
    const rawReadMs = (performance.now() - start) / iterations;
    start = performance.now();
    for (let i = 0; i < iterations; i++) deserialize(inflateRawSync(compressed));
    const compressedReadMs = (performance.now() - start) / iterations;
    assert.deepEqual(deserialize(inflateRawSync(compressed)), value);
    return { entropy, bytes: bytes.length, compressedBytes: compressed.length, encodeMs, rawReadMs, compressedReadMs };
  });
}

async function compareWorkerPreparation() {
  const samples = [];
  const source = { kind: 'serialized' as const, serializedRecording: JSON.stringify({ recording: { events: [] } }) };
  for (const prepared of [false, true]) {
    const extractor = new WorkflowRecordingInputExtractor();
    try {
      if (prepared) {
        extractor.prepare();
        // Explicitly model the time between catalog opening and clicking Search.
        await delay(250);
      }
      const start = performance.now();
      assert.deepEqual(await extractor.extract(source), { exists: false, value: undefined });
      samples.push({ prepared, catalogLeadMs: prepared ? 250 : 0, extractionMs: performance.now() - start });
    } finally {
      extractor.dispose();
    }
  }
  return samples;
}
await main();
