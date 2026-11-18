import type {
  ResourceHistory,
  ResourceInstanceHistory,
  ResourcePeriod,
  ResourceReport,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';
import { RESOURCE_PERIODS, fillResourceHistory, resourceStatistics } from './history.js';
import { RESOURCE_REPORT_MS, RESOURCE_SAMPLE_MS, RESOURCE_STALE_MS } from './sampler.js';
import { RESOURCE_MAX_INSTANCES, RESOURCE_RETENTION_MS, ResourceMonitoringStore } from './store.js';
import { isInstallationIdentity } from '../installation-identity.js';

const identifier = /^[a-zA-Z0-9_.-]{1,128}$/;
const finite = (value: unknown, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const optionalNumber = (value: unknown, max: number) => value === null || finite(value, max);

export function validateResourceReport(value: unknown, installation: string, now = Date.now()): ResourceReport {
  const report = value as ResourceReport;
  const id = report?.identity;
  if (
    !id ||
    id.installation !== installation ||
    !isInstallationIdentity(id.installation) ||
    typeof id.incarnation !== 'string' ||
    typeof id.name !== 'string' ||
    !identifier.test(id.incarnation) ||
    !identifier.test(id.name) ||
    !['execution', 'control', 'combined'].includes(id.role) ||
    !['cgroup-v1', 'cgroup-v2', 'node-process'].includes(id.source)
  )
    throw Error('Invalid resource identity');
  if (
    !report.allocation ||
    Object.values(report.allocation).length !== 4 ||
    !optionalNumber(report.allocation.cpuRequestMillicores, 1e9) ||
    !optionalNumber(report.allocation.cpuLimitMillicores, 1e9) ||
    !optionalNumber(report.allocation.memoryRequestBytes, 2 ** 50) ||
    !optionalNumber(report.allocation.memoryLimitBytes, 2 ** 50) ||
    !Number.isSafeInteger(report.droppedSamples) ||
    report.droppedSamples < 0
  )
    throw Error('Invalid resource allocation');
  if (!Array.isArray(report.buckets) || report.buckets.length < 1 || report.buckets.length > 6)
    throw Error('Invalid resource batch');
  const minutes = new Set<number>();
  for (const bucket of report.buckets) {
    if (
      !Number.isSafeInteger(bucket.at) ||
      bucket.at % 60000 ||
      bucket.at < now - RESOURCE_RETENTION_MS ||
      bucket.at > now + 30000 ||
      minutes.has(bucket.at) ||
      !Number.isSafeInteger(bucket.revision) ||
      bucket.revision < 1 ||
      !Array.isArray(bucket.samples) ||
      !bucket.samples.length ||
      bucket.samples.length > 24
    )
      throw Error('Invalid resource minute');
    minutes.add(bucket.at);
    let previous = -Infinity;
    for (const s of bucket.samples) {
      if (
        !finite(s.at, now + 30000) ||
        s.at < bucket.at ||
        s.at >= bucket.at + 60000 ||
        Math.floor(s.at / RESOURCE_SAMPLE_MS) <= Math.floor(previous / RESOURCE_SAMPLE_MS) ||
        !finite(s.durationMs, 12500) ||
        !optionalNumber(s.cpuMillicores, 1e9) ||
        !finite(s.memoryBytes, 2 ** 50) ||
        !optionalNumber(s.workingSetBytes, 2 ** 50) ||
        !optionalNumber(s.lifetimeMemoryPeakBytes, 2 ** 50) ||
        !optionalNumber(s.activeRuns, 1e9) ||
        !optionalNumber(s.runLimit, 10000)
      )
        throw Error('Invalid resource sample');
      previous = s.at;
    }
  }
  // Copy only the telemetry contract; unknown request data is never persisted.
  return {
    identity: {
      installation: id.installation,
      incarnation: id.incarnation,
      role: id.role,
      name: id.name,
      source: id.source,
    },
    allocation: {
      cpuRequestMillicores: report.allocation.cpuRequestMillicores,
      memoryRequestBytes: report.allocation.memoryRequestBytes,
      cpuLimitMillicores: report.allocation.cpuLimitMillicores,
      memoryLimitBytes: report.allocation.memoryLimitBytes,
    },
    droppedSamples: report.droppedSamples,
    buckets: report.buckets.map((b) => ({
      at: b.at,
      revision: b.revision,
      samples: b.samples.map((s) => ({
        at: s.at,
        durationMs: s.durationMs,
        cpuMillicores: s.cpuMillicores,
        memoryBytes: s.memoryBytes,
        workingSetBytes: s.workingSetBytes,
        lifetimeMemoryPeakBytes: s.lifetimeMemoryPeakBytes,
        activeRuns: s.activeRuns,
        runLimit: s.runLimit,
      })),
    })),
  };
}

export function unavailableResourceHistory(period: ResourcePeriod, now = Date.now()): ResourceHistory {
  return {
    available: false,
    error: 'Resource monitoring is unavailable. No resource values have been inferred.',
    period,
    from: now - RESOURCE_PERIODS[period].duration,
    to: now,
    generatedAt: now,
    sampleIntervalMs: RESOURCE_SAMPLE_MS,
    staleAfterMs: RESOURCE_STALE_MS,
    percentile: 'approximate-duration-weighted',
    instances: [],
    pools: [],
    omittedInstances: 0,
  };
}

type HistoryStore = Pick<ResourceMonitoringStore, 'write' | 'cleanup' | 'history'>;
/** Shared across browser requests. Reporting and historical writes never run in a graph handler. */
export class ResourceMonitoringHub {
  readonly pending = new Map<string, ResourceReport>();
  readonly latest = new Map<string, ResourceReport>();
  readonly cache = new Map<ResourcePeriod, { at: number; data: ResourceHistory }>();
  readonly reads = new Map<ResourcePeriod, Promise<ResourceHistory>>();
  private writing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private nextWrite = 0;
  private lastCleanup = 0;
  private failures = 0;
  constructor(
    readonly installation: string,
    private readonly store: HistoryStore,
    private readonly now = Date.now,
  ) {}

  ingest(value: unknown): void {
    const report = validateResourceReport(value, this.installation, this.now()),
      key = report.identity.incarnation;
    const previous = this.latest.get(key);
    if (previous && JSON.stringify(previous.identity) !== JSON.stringify(report.identity))
      throw Error('Resource identity changed');
    const newest = (r: ResourceReport) => Math.max(...r.buckets.flatMap((b) => b.samples.map((s) => s.at)));
    if (previous && newest(previous) > newest(report)) return;
    if (!previous && this.latest.size >= RESOURCE_MAX_INSTANCES * 2) {
      const oldest = [...this.latest].sort((a, b) => newest(a[1]) - newest(b[1]))[0]![0];
      this.latest.delete(oldest);
      this.pending.delete(oldest);
    }
    const pending = this.pending.get(key);
    if (pending) {
      const buckets = new Map(pending.buckets.map((b) => [b.at, b]));
      for (const b of report.buckets) if ((buckets.get(b.at)?.revision ?? 0) <= b.revision) buckets.set(b.at, b);
      report.buckets = [...buckets.values()].sort((a, b) => b.at - a.at).slice(0, 6);
    }
    this.latest.set(key, report);
    this.pending.set(key, report);
  }

  flush(): Promise<void> {
    if (this.writing || this.stopped || this.now() < this.nextWrite) return this.writing ?? Promise.resolve();
    const reports = [...this.pending.values()].slice(0, 32);
    this.writing = (async () => {
      try {
        await this.store.write(reports);
        for (const report of reports) {
          const key = report.identity.incarnation;
          const newer = this.pending.get(key);
          this.pending.delete(key);
          // A continuously reporting worker must not starve later workers.
          if (newer && newer !== report) this.pending.set(key, newer);
        }
        if (this.now() - this.lastCleanup >= 60000) {
          this.lastCleanup = this.now();
          // Retention is best effort and must not back off healthy ingestion.
          await this.store.cleanup(this.now()).catch(() => {
            console.warn('[resource-monitoring] Retention cleanup delayed; the next maintenance interval will retry.');
          });
        }
        this.failures = 0;
        this.nextWrite = this.now() + RESOURCE_REPORT_MS;
      } catch {
        this.failures = Math.min(3, this.failures + 1);
        this.nextWrite = this.now() + Math.min(120000, RESOURCE_REPORT_MS * 2 ** this.failures);
      }
    })().finally(() => {
      this.writing = undefined;
    });
    return this.writing;
  }

  async history(period: ResourcePeriod): Promise<ResourceHistory> {
    const cached = this.cache.get(period);
    if (cached && this.now() - cached.at < RESOURCE_REPORT_MS) return this.overlay(cached.data);
    let read = this.reads.get(period);
    if (!read) {
      read = this.store
        .history(period, this.now())
        .then((data) => {
          this.cache.set(period, { at: this.now(), data });
          return data;
        })
        .catch(() => {
          const data = cached
            ? {
                ...cached.data,
                error: 'Historical resource data could not be refreshed; showing the last available observations.',
              }
            : unavailableResourceHistory(period, this.now());
          this.cache.set(period, { at: this.now(), data });
          return data;
        })
        .finally(() => this.reads.delete(period));
      this.reads.set(period, read);
    }
    return this.overlay(await read);
  }

  private overlay(data: ResourceHistory): ResourceHistory {
    const instances = new Map(data.instances.map((i) => [i.identity.incarnation, i]));
    for (const report of this.latest.values()) {
      const samples = report.buckets.flatMap((b) => b.samples).sort((a, b) => a.at - b.at),
        latest = samples.at(-1)!;
      if (latest.at < data.from) continue;
      const old = instances.get(report.identity.incarnation);
      if (old && old.lastSampleAt > latest.at) continue;
      const base: ResourceInstanceHistory = old ?? {
        identity: report.identity,
        allocation: report.allocation,
        firstSampleAt: samples[0]!.at,
        lastSampleAt: latest.at,
        latest,
        droppedSamples: report.droppedSamples,
        cpu: resourceStatistics(),
        memory: resourceStatistics(),
        workingSet: resourceStatistics(),
        points: fillResourceHistory([], data.from, data.to, RESOURCE_PERIODS[data.period].step),
      };
      instances.set(report.identity.incarnation, {
        ...base,
        allocation: report.allocation,
        lastSampleAt: latest.at,
        latest,
        droppedSamples: report.droppedSamples,
      });
    }
    const sorted = [...instances.values()].sort((a, b) => b.lastSampleAt - a.lastSampleAt);
    return {
      ...data,
      error: this.failures ? 'Historical resource writes are delayed; available samples may contain gaps.' : data.error,
      instances: sorted.slice(0, RESOURCE_MAX_INSTANCES),
      // Database omissions can already be represented in the live cache.
      omittedInstances: Math.max(data.omittedInstances, sorted.length - RESOURCE_MAX_INSTANCES),
    };
  }

  start(): void {
    if (!this.timer && !this.stopped) {
      this.timer = setInterval(() => {
        void this.flush();
      }, RESOURCE_REPORT_MS);
      this.timer.unref?.();
    }
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
