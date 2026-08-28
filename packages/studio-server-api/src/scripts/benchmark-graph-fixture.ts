import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import express from 'express';

type BenchmarkMode = 'legacy-compatible' | 'optimized';

const RUN_RECORDINGS_SETTINGS_RELATIVE_PATH = path.join('settings', 'run-recordings.json');

type ParsedArgs = {
  fixture: string;
  endpoint: string;
  runs: number;
  warmups: number;
  body: string | null;
  keepTemp: boolean;
};

type ResolvedBenchmarkBody = {
  body: string | null;
  source: string;
};

type BenchmarkSample = {
  status: number;
  totalClientMs: number;
  durationMs: number | null;
  workflowExecuteMs: number | null;
  workflowResolveMs: number | null;
  workflowMaterializeMs: number | null;
  workflowCache: string | null;
  codeRunnerCalls: number | null;
  codeRunnerRequireCalls: number | null;
  codeRunnerPrepareMs: number | null;
  codeRunnerCompileMs: number | null;
  codeRunnerExecuteMs: number | null;
  codeRunnerCacheHits: number | null;
  codeRunnerCacheMisses: number | null;
  codeRunnerCache: string | null;
  body: string;
};

type BenchmarkSummary = {
  mode: BenchmarkMode;
  runs: number;
  warmups: number;
  meanTotalClientMs: number;
  p95TotalClientMs: number;
  meanDurationMs: number | null;
  p95DurationMs: number | null;
  meanWorkflowExecuteMs: number | null;
  p95WorkflowExecuteMs: number | null;
  meanCodeRunnerPrepareMs: number | null;
  meanCodeRunnerCompileMs: number | null;
  meanCodeRunnerExecuteMs: number | null;
  codeRunnerCalls: number | null;
  codeRunnerRequireCalls: number | null;
  codeRunnerCacheHits: number | null;
  codeRunnerCacheMisses: number | null;
  workflowCacheValues: string[];
  codeRunnerCacheValues: string[];
};

type BenchmarkReport = {
  fixture: string;
  endpoint: string;
  nodeVersion: string;
  tempRoot: string;
  bodySource: string;
  bodyBytes: number | null;
  summaries: BenchmarkSummary[];
  outputEquivalent: boolean;
  outputComparisonNote: string;
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../../../..');
const DEFAULT_FIXTURE = path.join(REPO_ROOT, '.fixtures', 'graph-fixture.rivet-project');
const DEFAULT_ENDPOINT = 'graph-fixture-speed';

function printUsage(): void {
  console.error(
    'Usage: yarn workspace @valerypopoff/rivet-studio-server-api run workflow-execution:benchmark-fixture -- ' +
    '[--fixture .fixtures/graph-fixture.rivet-project] [--endpoint graph-fixture-speed] ' +
    '[--runs 30] [--warmups 10] [--body \'<json>\'] [--keep-temp]',
  );
}

function parseIntegerOption(value: string | undefined, optionName: string, fallback: number): number {
  if (value == null || value.trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }

  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      options.set(token.slice(2, equalsIndex), token.slice(equalsIndex + 1));
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) {
      flags.add(key);
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  const bodyOption = options.get('body');
  const body = bodyOption == null ? null : bodyOption.trim() || '{}';
  if (body != null) {
    JSON.parse(body);
  }

  return {
    fixture: path.resolve(REPO_ROOT, options.get('fixture') ?? DEFAULT_FIXTURE),
    endpoint: options.get('endpoint')?.trim() || DEFAULT_ENDPOINT,
    runs: parseIntegerOption(options.get('runs'), '--runs', 30),
    warmups: parseIntegerOption(options.get('warmups'), '--warmups', 10),
    body,
    keepTemp: flags.has('keep-temp'),
  };
}

function getNumericHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function p95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function numericValues(samples: BenchmarkSample[], key: keyof BenchmarkSample): number[] {
  return samples
    .map((sample) => sample[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function firstNumericValue(samples: BenchmarkSample[], key: keyof BenchmarkSample): number | null {
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function distinctStringValues(samples: BenchmarkSample[], key: keyof BenchmarkSample): string[] {
  return [...new Set(samples.map((sample) => sample[key]).filter((value): value is string => typeof value === 'string'))];
}

function summarize(mode: BenchmarkMode, samples: BenchmarkSample[], warmups: number): BenchmarkSummary {
  return {
    mode,
    runs: samples.length,
    warmups,
    meanTotalClientMs: mean(numericValues(samples, 'totalClientMs')) ?? 0,
    p95TotalClientMs: p95(numericValues(samples, 'totalClientMs')) ?? 0,
    meanDurationMs: mean(numericValues(samples, 'durationMs')),
    p95DurationMs: p95(numericValues(samples, 'durationMs')),
    meanWorkflowExecuteMs: mean(numericValues(samples, 'workflowExecuteMs')),
    p95WorkflowExecuteMs: p95(numericValues(samples, 'workflowExecuteMs')),
    meanCodeRunnerPrepareMs: mean(numericValues(samples, 'codeRunnerPrepareMs')),
    meanCodeRunnerCompileMs: mean(numericValues(samples, 'codeRunnerCompileMs')),
    meanCodeRunnerExecuteMs: mean(numericValues(samples, 'codeRunnerExecuteMs')),
    codeRunnerCalls: firstNumericValue(samples, 'codeRunnerCalls'),
    codeRunnerRequireCalls: firstNumericValue(samples, 'codeRunnerRequireCalls'),
    codeRunnerCacheHits: firstNumericValue(samples, 'codeRunnerCacheHits'),
    codeRunnerCacheMisses: firstNumericValue(samples, 'codeRunnerCacheMisses'),
    workflowCacheValues: distinctStringValues(samples, 'workflowCache'),
    codeRunnerCacheValues: distinctStringValues(samples, 'codeRunnerCache'),
  };
}

function normalizeResponseBody(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as unknown;
    return stripTimingFields(parsed);
  } catch {
    return body;
  }
}

function stripTimingFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripTimingFields);
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (key === 'durationMs') {
        continue;
      }

      result[key] = stripTimingFields(entryValue);
    }
    return result;
  }

  return value;
}

function setModeEnvironment(mode: BenchmarkMode): void {
  process.env.RIVET_WORKFLOW_EXECUTION_DEBUG_HEADERS = 'true';
  process.env.RIVET_CODE_RUNNER_TELEMETRY = 'true';

  if (mode === 'legacy-compatible') {
    process.env.RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE = 'true';
    process.env.RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE = 'true';
    return;
  }

  delete process.env.RIVET_MANAGED_CODE_RUNNER_DISABLE_CACHE;
  delete process.env.RIVET_MANAGED_CODE_RUNNER_FORCE_PREPARE_EVERY_CODE;
}

async function listen(server: http.Server): Promise<{ baseUrl: string; close(): Promise<void> }> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind benchmark server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}

async function runBenchmarkMode(options: {
  mode: BenchmarkMode;
  endpointUrl: string;
  body: string | null;
  runs: number;
  warmups: number;
  resetCodeRunnerCache: () => void;
}): Promise<{ samples: BenchmarkSample[]; warmupSamples: BenchmarkSample[] }> {
  setModeEnvironment(options.mode);
  options.resetCodeRunnerCache();

  const totalRequests = options.warmups + options.runs;
  const samples: BenchmarkSample[] = [];
  const warmupSamples: BenchmarkSample[] = [];

  for (let index = 0; index < totalRequests; index += 1) {
    const startedAt = performance.now();
    const requestInit: RequestInit = {
      method: 'POST',
    };
    if (options.body != null) {
      requestInit.headers = { 'Content-Type': 'application/json' };
      requestInit.body = options.body;
    }

    const response = await fetch(options.endpointUrl, {
      ...requestInit,
    });
    const responseBody = await response.text();
    const totalClientMs = Math.max(0, Math.round(performance.now() - startedAt));

    const sample: BenchmarkSample = {
      status: response.status,
      totalClientMs,
      durationMs: getNumericHeader(response.headers, 'x-duration-ms'),
      workflowExecuteMs: getNumericHeader(response.headers, 'x-workflow-execute-ms'),
      workflowResolveMs: getNumericHeader(response.headers, 'x-workflow-resolve-ms'),
      workflowMaterializeMs: getNumericHeader(response.headers, 'x-workflow-materialize-ms'),
      workflowCache: response.headers.get('x-workflow-cache'),
      codeRunnerCalls: getNumericHeader(response.headers, 'x-code-runner-calls'),
      codeRunnerRequireCalls: getNumericHeader(response.headers, 'x-code-runner-require-calls'),
      codeRunnerPrepareMs: getNumericHeader(response.headers, 'x-code-runner-prepare-ms'),
      codeRunnerCompileMs: getNumericHeader(response.headers, 'x-code-runner-compile-ms'),
      codeRunnerExecuteMs: getNumericHeader(response.headers, 'x-code-runner-execute-ms'),
      codeRunnerCacheHits: getNumericHeader(response.headers, 'x-code-runner-cache-hits'),
      codeRunnerCacheMisses: getNumericHeader(response.headers, 'x-code-runner-cache-misses'),
      codeRunnerCache: response.headers.get('x-code-runner-cache'),
      body: responseBody,
    };

    if (!response.ok) {
      throw new Error(
        `${options.mode} benchmark request failed with HTTP ${response.status}: ${responseBody.slice(0, 1000)}`,
      );
    }

    if (index < options.warmups) {
      warmupSamples.push(sample);
    } else {
      samples.push(sample);
    }
  }

  return { samples, warmupSamples };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-graph-fixture-benchmark-'));
  const workflowsRoot = path.join(tempRoot, 'workflows');
  const recordingsRoot = path.join(tempRoot, 'workflow-recordings');
  const appDataRoot = path.join(tempRoot, 'app-data');
  const runtimeLibrariesRoot = path.join(tempRoot, 'runtime-libraries');
  const totalBenchmarkRequests = (args.runs + args.warmups) * 2;

  process.env.RIVET_WORKFLOWS_ROOT = workflowsRoot;
  process.env.RIVET_WORKFLOW_RECORDINGS_ROOT = recordingsRoot;
  process.env.RIVET_APP_DATA_ROOT = appDataRoot;
  process.env.RIVET_RUNTIME_LIBRARIES_ROOT = runtimeLibrariesRoot;

  await fs.mkdir(workflowsRoot, { recursive: true });
  await fs.mkdir(recordingsRoot, { recursive: true });
  await fs.mkdir(appDataRoot, { recursive: true });
  await fs.mkdir(runtimeLibrariesRoot, { recursive: true });
  const recordingsSettingsPath = path.join(appDataRoot, RUN_RECORDINGS_SETTINGS_RELATIVE_PATH);
  await fs.mkdir(path.dirname(recordingsSettingsPath), { recursive: true });
  await fs.writeFile(recordingsSettingsPath, JSON.stringify({
    version: 1,
    maxPendingWrites: Math.max(1000, totalBenchmarkRequests + 10),
    maxRunsPerEndpoint: Math.max(100, totalBenchmarkRequests + 10),
    retentionDays: 14,
  }), 'utf8');

  const fixtureContents = await fs.readFile(args.fixture, 'utf8');
  const benchmarkBody = args.body == null
    ? { body: null, source: 'no request body; graph input defaults may apply' }
    : { body: args.body, source: 'explicit --body option' };

  const [
    workflowMutations,
    workflowStorageBackend,
    workflowRoutes,
    workflowRecordings,
    filesystemExecutionCache,
    managedCodeRunner,
  ] = await Promise.all([
    import('../routes/workflows/workflow-mutations.js'),
    import('../routes/workflows/storage-backend.js'),
    import('../routes/workflows/index.js'),
    import('../routes/workflows/recordings.js'),
    import('../routes/workflows/filesystem-execution-cache.js'),
    import('../runtime-libraries/managed-code-runner.js'),
  ]);
  const resetCodeRunnerCacheForTests = (
    managedCodeRunner as { resetManagedCodeRunnerCacheForTests?: unknown }
  ).resetManagedCodeRunnerCacheForTests;
  const resetCodeRunnerCache: () => void =
    typeof resetCodeRunnerCacheForTests === 'function'
      ? () => resetCodeRunnerCacheForTests()
      : () => {};

  await workflowStorageBackend.initializeWorkflowStorage();
  const projectPath = path.join(workflowsRoot, 'GraphFixture.rivet-project');
  await fs.writeFile(projectPath, fixtureContents, 'utf8');
  await workflowMutations.publishWorkflowProjectItem('GraphFixture.rivet-project', {
    endpointName: args.endpoint,
  });

  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/api/workflows', workflowRoutes.workflowsRouter);
  app.use('/workflows', workflowRoutes.publishedWorkflowsRouter);
  app.use('/workflows-latest', workflowRoutes.latestWorkflowsRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((err as { status?: number }).status ?? 500).json({ error: err.message });
  });

  const server = http.createServer(app);
  const listener = await listen(server);

  try {
    const endpointUrl = `${listener.baseUrl}/workflows/${encodeURIComponent(args.endpoint)}`;
    const legacy = await runBenchmarkMode({
      mode: 'legacy-compatible',
      endpointUrl,
      body: benchmarkBody.body,
      runs: args.runs,
      warmups: args.warmups,
      resetCodeRunnerCache,
    });
    const optimized = await runBenchmarkMode({
      mode: 'optimized',
      endpointUrl,
      body: benchmarkBody.body,
      runs: args.runs,
      warmups: args.warmups,
      resetCodeRunnerCache,
    });

    const legacyOutput = normalizeResponseBody(legacy.samples[0]?.body ?? '');
    const optimizedOutput = normalizeResponseBody(optimized.samples[0]?.body ?? '');
    const outputEquivalent = JSON.stringify(legacyOutput) === JSON.stringify(optimizedOutput);
    const report: BenchmarkReport = {
      fixture: args.fixture,
      endpoint: args.endpoint,
      nodeVersion: process.version,
      tempRoot,
      bodySource: benchmarkBody.source,
      bodyBytes: benchmarkBody.body == null ? null : Buffer.byteLength(benchmarkBody.body, 'utf8'),
      summaries: [
        summarize('legacy-compatible', legacy.samples, args.warmups),
        summarize('optimized', optimized.samples, args.warmups),
      ],
      outputEquivalent,
      outputComparisonNote: outputEquivalent
        ? 'First measured legacy and optimized response bodies match after removing durationMs fields.'
        : 'First measured legacy and optimized response bodies differ after removing durationMs fields.',
    };

    const artifactsRoot = path.join(REPO_ROOT, 'artifacts', 'benchmarks');
    await fs.mkdir(artifactsRoot, { recursive: true });
    const artifactPath = path.join(
      artifactsRoot,
      `graph-fixture-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await fs.writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify(report, null, 2));
    console.log(`Benchmark report written to ${artifactPath}`);
  } finally {
    await listener.close();
    await workflowRecordings.resetWorkflowRecordingStorageForTests();
    filesystemExecutionCache.resetFilesystemExecutionCacheForTests();
    resetCodeRunnerCache();
    if (!args.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

await main();
