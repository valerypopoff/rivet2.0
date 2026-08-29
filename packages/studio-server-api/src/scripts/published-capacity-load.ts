import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

export type CapacityLoadScenario = {
  name: string;
  endpoint: string;
  body: unknown;
};

export type CapacityLoadStage = {
  name: string;
  scenario: string;
  concurrency: number;
  requests: number;
  expect: 'success' | 'overload';
};

export type CapacityLoadConfig = {
  version: 1;
  proxyBaseUrl: string;
  controlBaseUrl: string;
  requestTimeoutMs: number;
  controlCanaryEveryRequests: number;
  controlCanaryTimeoutMs: number;
  scenarios: CapacityLoadScenario[];
  stages: CapacityLoadStage[];
};

type TimingSummary = {
  count: number;
  minMs: number;
  maxMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

type RequestSample = {
  status: number | null;
  durationMs: number;
  errorKind?: 'network' | 'timeout';
};

export type CapacityLoadStageReport = {
  name: string;
  scenario: string;
  requested: number;
  completed: number;
  maxConcurrentObserved: number;
  statusCounts: Record<string, number>;
  requestTimings: TimingSummary;
  controlCanaries: {
    attempted: number;
    succeeded: number;
    failures: number;
    timings: TimingSummary;
  };
  outcomes: {
    succeeded: number;
    capacityRejected: number;
    serverErrors: number;
    clientErrors: number;
    networkErrors: number;
    timeouts: number;
    unexpected: number;
  };
};

export type CapacityLoadReport = {
  version: 1;
  startedAt: string;
  completedAt: string;
  stages: CapacityLoadStageReport[];
};

export type CapacityLoadDependencies = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

const MAX_CONCURRENCY = 512;
const MAX_REQUESTS_PER_STAGE = 100_000;
const safeStageName = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const safeEndpoint = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${name} must be an object.`);
  }
}

function parseUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment.`);
  }
  return url;
}

function assertPositiveInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value as number;
}

export function validateCapacityLoadConfig(value: unknown): CapacityLoadConfig {
  assertRecord(value, 'capacity load config');
  if (value.version !== 1) throw new Error('capacity load config.version must equal 1.');

  if (Object.hasOwn(value, 'requestHeaders')) {
    throw new Error('capacity load config does not accept requestHeaders.');
  }
  const proxyBaseUrl = parseUrl(String(value.proxyBaseUrl ?? ''), 'proxyBaseUrl').origin;
  const controlBaseUrl = parseUrl(String(value.controlBaseUrl ?? ''), 'controlBaseUrl').origin;
  const requestTimeoutMs = assertPositiveInteger(value.requestTimeoutMs, 'requestTimeoutMs', 120_000);
  const controlCanaryEveryRequests = assertPositiveInteger(
    value.controlCanaryEveryRequests,
    'controlCanaryEveryRequests',
    10_000,
  );
  const controlCanaryTimeoutMs = assertPositiveInteger(value.controlCanaryTimeoutMs, 'controlCanaryTimeoutMs', 120_000);

  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 16) {
    throw new Error('scenarios must contain between 1 and 16 scenarios.');
  }
  const scenarioNames = new Set<string>();
  const scenarios = value.scenarios.map((rawScenario, index): CapacityLoadScenario => {
    assertRecord(rawScenario, `scenarios[${index}]`);
    const name = String(rawScenario.name ?? '');
    const endpoint = String(rawScenario.endpoint ?? '');
    if (!safeStageName.test(name) || scenarioNames.has(name)) {
      throw new Error(`scenarios[${index}].name must be a unique lowercase DNS-label fragment.`);
    }
    if (!safeEndpoint.test(endpoint)) {
      throw new Error(
        `scenarios[${index}].endpoint must be one safe published endpoint slug; latest routes are forbidden.`,
      );
    }
    scenarioNames.add(name);
    return {
      name,
      endpoint,
      body: rawScenario.body,
    };
  });

  if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 16) {
    throw new Error('stages must contain between 1 and 16 stages.');
  }
  const stageNames = new Set<string>();
  const stages = value.stages.map((rawStage, index): CapacityLoadStage => {
    assertRecord(rawStage, `stages[${index}]`);
    const name = String(rawStage.name ?? '');
    const scenario = String(rawStage.scenario ?? '');
    const expect = rawStage.expect;
    if (!safeStageName.test(name) || stageNames.has(name)) {
      throw new Error(`stages[${index}].name must be a unique lowercase DNS-label fragment.`);
    }
    if (!scenarioNames.has(scenario)) throw new Error(`stages[${index}].scenario must name a configured scenario.`);
    if (expect !== 'success' && expect !== 'overload')
      throw new Error(`stages[${index}].expect must be success or overload.`);
    stageNames.add(name);
    return {
      name,
      scenario,
      concurrency: assertPositiveInteger(rawStage.concurrency, `stages[${index}].concurrency`, MAX_CONCURRENCY),
      requests: assertPositiveInteger(rawStage.requests, `stages[${index}].requests`, MAX_REQUESTS_PER_STAGE),
      expect,
    };
  });

  return {
    version: 1,
    proxyBaseUrl,
    controlBaseUrl,
    requestTimeoutMs,
    controlCanaryEveryRequests,
    controlCanaryTimeoutMs,
    scenarios,
    stages,
  };
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1));
  return Math.round(ordered[index] * 100) / 100;
}

export function summarizeTimings(values: number[]): TimingSummary {
  if (values.length === 0) return { count: 0, minMs: 0, maxMs: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    minMs: Math.round(Math.min(...values) * 100) / 100,
    maxMs: Math.round(Math.max(...values) * 100) / 100,
    averageMs: Math.round((total / values.length) * 100) / 100,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
  };
}

function buildPublishedUrl(proxyBaseUrl: string, endpoint: string): string {
  return new URL(`/workflows/${encodeURIComponent(endpoint)}`, proxyBaseUrl).toString();
}

async function requestSample(
  fetchImplementation: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
  now: () => number,
): Promise<RequestSample> {
  const started = now();
  try {
    const response = await fetchImplementation(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return { status: response.status, durationMs: now() - started };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      status: null,
      durationMs: now() - started,
      errorKind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}

async function controlCanary(
  fetchImplementation: typeof fetch,
  controlBaseUrl: string,
  timeoutMs: number,
  now: () => number,
): Promise<RequestSample> {
  const started = now();
  try {
    const response = await fetchImplementation(new URL('/readyz', controlBaseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
    return { status: response.status, durationMs: now() - started };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      status: null,
      durationMs: now() - started,
      errorKind: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
    };
  }
}

function classifySample(
  sample: RequestSample,
  expected: CapacityLoadStage['expect'],
  outcomes: CapacityLoadStageReport['outcomes'],
  statusCounts: Record<string, number>,
): void {
  const key = sample.status === null ? sample.errorKind ?? 'network' : String(sample.status);
  statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  if (sample.status === null) {
    if (sample.errorKind === 'timeout') outcomes.timeouts += 1;
    else outcomes.networkErrors += 1;
    outcomes.unexpected += 1;
    return;
  }
  if (sample.status >= 200 && sample.status < 300) {
    outcomes.succeeded += 1;
    return;
  }
  if (sample.status === 429) {
    outcomes.capacityRejected += 1;
    if (expected !== 'overload') outcomes.unexpected += 1;
    return;
  }
  if (sample.status >= 500) outcomes.serverErrors += 1;
  else outcomes.clientErrors += 1;
  outcomes.unexpected += 1;
}

export async function runPublishedCapacityLoad(
  rawConfig: unknown,
  dependencies: CapacityLoadDependencies = {},
): Promise<CapacityLoadReport> {
  const config = validateCapacityLoadConfig(rawConfig);
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => performance.now());
  if (typeof fetchImplementation !== 'function') throw new Error('A fetch implementation is required.');
  const startedAt = new Date().toISOString();
  const scenarios = new Map(config.scenarios.map((scenario) => [scenario.name, scenario]));
  const reports: CapacityLoadStageReport[] = [];

  for (const stage of config.stages) {
    const scenario = scenarios.get(stage.scenario);
    if (!scenario) throw new Error(`Unknown scenario ${stage.scenario}.`);
    let nextRequest = 0;
    let inFlight = 0;
    let maxConcurrentObserved = 0;
    let canaryCounter = 0;
    const timings: number[] = [];
    const canaryTimings: number[] = [];
    const statusCounts: Record<string, number> = {};
    const outcomes: CapacityLoadStageReport['outcomes'] = {
      succeeded: 0,
      capacityRejected: 0,
      serverErrors: 0,
      clientErrors: 0,
      networkErrors: 0,
      timeouts: 0,
      unexpected: 0,
    };
    const canaries = { attempted: 0, succeeded: 0, failures: 0 };

    const worker = async (): Promise<void> => {
      while (true) {
        const requestIndex = nextRequest;
        nextRequest += 1;
        if (requestIndex >= stage.requests) return;
        inFlight += 1;
        maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlight);
        try {
          const sample = await requestSample(
            fetchImplementation,
            buildPublishedUrl(config.proxyBaseUrl, scenario.endpoint),
            scenario.body,
            config.requestTimeoutMs,
            now,
          );
          timings.push(sample.durationMs);
          classifySample(sample, stage.expect, outcomes, statusCounts);
          canaryCounter += 1;
          if (canaryCounter % config.controlCanaryEveryRequests === 0) {
            canaries.attempted += 1;
            const canary = await controlCanary(
              fetchImplementation,
              config.controlBaseUrl,
              config.controlCanaryTimeoutMs,
              now,
            );
            canaryTimings.push(canary.durationMs);
            if (canary.status === 200) canaries.succeeded += 1;
            else canaries.failures += 1;
          }
        } finally {
          inFlight -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(stage.concurrency, stage.requests) }, () => worker()));
    reports.push({
      name: stage.name,
      scenario: stage.scenario,
      requested: stage.requests,
      completed: Object.values(statusCounts).reduce((sum, value) => sum + value, 0),
      maxConcurrentObserved,
      statusCounts,
      requestTimings: summarizeTimings(timings),
      controlCanaries: { ...canaries, timings: summarizeTimings(canaryTimings) },
      outcomes,
    });
  }

  return { version: 1, startedAt, completedAt: new Date().toISOString(), stages: reports };
}

async function main(): Promise<void> {
  const [flag, filePath] = process.argv.slice(2);
  if (flag !== '--config' || !filePath || process.argv.length !== 4) {
    throw new Error('Usage: published-capacity-load --config <absolute-config-path>');
  }
  const { readFile } = await import('node:fs/promises');
  const report = await runPublishedCapacityLoad(JSON.parse(await readFile(filePath, 'utf8')));
  process.stdout.write(`RIVET_CAPACITY_REPORT=${Buffer.from(JSON.stringify(report)).toString('base64url')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
