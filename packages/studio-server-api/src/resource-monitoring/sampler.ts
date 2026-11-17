import { performance } from 'node:perf_hooks';
import type {
  ResourceAllocation,
  ResourceIdentity,
  ResourceMinute,
  ResourceReport,
  ResourceSample,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';
import type { ResourceCounterReader } from './counters.js';
import type { PublishedExecutionAdmissionSnapshot } from '../published-execution-admission.js';

export const RESOURCE_SAMPLE_MS = 5000;
export const RESOURCE_REPORT_MS = 30000;
export const RESOURCE_STALE_MS = 90000;
export const RESOURCE_BUFFER_MINUTES = 6;

/** One bounded owner per API container; no workflow callback or per-run I/O. */
export function createResourceSampler(options: {
  identity: ResourceIdentity;
  allocation: ResourceAllocation;
  reader: ResourceCounterReader;
  report(report: ResourceReport, signal: AbortSignal): Promise<void>;
  activity(): Pick<PublishedExecutionAdmissionSnapshot, 'activeRuns' | 'maxActiveRuns' | 'mode'> | null;
  now?: () => number;
  monotonic?: () => number;
  sampleMs?: number;
  reportMs?: number;
}) {
  const now = options.now ?? Date.now,
    monotonic = options.monotonic ?? (() => performance.now());
  const sampleMs = options.sampleMs ?? RESOURCE_SAMPLE_MS,
    reportMs = options.reportMs ?? RESOURCE_REPORT_MS;
  const buckets = new Map<number, ResourceMinute>();
  let previous: { cpu: number; monotonic: number } | undefined;
  let revision = 0,
    droppedSamples = 0,
    stopped = false,
    sampling = false;
  let started = false,
    lastAt = -Infinity;
  const configuredCpuLimit = options.allocation.cpuLimitMillicores;
  const configuredMemoryLimit = options.allocation.memoryLimitBytes;
  let reportFlight: Promise<void> | undefined, abort: AbortController | undefined;
  let nextReport = 0,
    failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function sample() {
    if (stopped || sampling) return;
    sampling = true;
    try {
      const counter = await options.reader.read();
      if (stopped) return;
      const tick = monotonic(),
        at = now();
      if (Math.floor(at / sampleMs) <= Math.floor(lastAt / sampleMs)) {
        previous = undefined;
        droppedSamples++;
        return;
      }
      lastAt = at;
      const elapsed = previous ? tick - previous.monotonic : 0;
      const continuous = elapsed > 0 && elapsed <= sampleMs * 2.5;
      const cpu =
        previous && continuous && counter.cpuMicros >= previous.cpu
          ? (counter.cpuMicros - previous.cpu) / elapsed
          : null;
      previous = { cpu: counter.cpuMicros, monotonic: tick };
      const activity = options.activity();
      const point: ResourceSample = {
        at,
        durationMs: continuous ? elapsed : 0,
        cpuMillicores: cpu,
        memoryBytes: counter.memoryBytes,
        workingSetBytes: counter.workingSetBytes,
        lifetimeMemoryPeakBytes: counter.lifetimeMemoryPeakBytes,
        activeRuns: activity && activity.mode !== 'disabled' ? activity.activeRuns : null,
        runLimit: activity?.mode === 'enforce' ? activity.maxActiveRuns : null,
      };
      const minute = Math.floor(at / 60000) * 60000;
      const bucket = buckets.get(minute) ?? { at: minute, revision: 0, samples: [] };
      bucket.revision = ++revision;
      if (bucket.samples.length < 24) bucket.samples.push(point);
      else droppedSamples++;
      buckets.set(minute, bucket);
      while (buckets.size > RESOURCE_BUFFER_MINUTES) {
        const oldest = [...buckets.keys()].sort((a, b) => a - b)[0]!;
        droppedSamples += buckets.get(oldest)!.samples.length;
        buckets.delete(oldest);
      }
      options.allocation.cpuLimitMillicores = configuredCpuLimit ?? counter.cpuLimitMillicores;
      options.allocation.memoryLimitBytes = configuredMemoryLimit ?? counter.memoryLimitBytes;
    } catch {
      previous = undefined;
      droppedSamples++;
    } finally {
      sampling = false;
    }
  }

  function flush(force = false): Promise<void> {
    if (stopped || reportFlight || !buckets.size || (!force && monotonic() < nextReport))
      return reportFlight ?? Promise.resolve();
    const report: ResourceReport = structuredClone({
      identity: options.identity,
      allocation: options.allocation,
      buckets: [...buckets.values()],
      droppedSamples,
    });
    abort = new AbortController();
    const timeout = setTimeout(() => abort?.abort(), 5000);
    timeout.unref?.();
    reportFlight = Promise.resolve()
      .then(() => options.report(report, abort!.signal))
      .then(() => {
        failures = 0;
        nextReport = monotonic() + reportMs;
        const currentMinute = Math.floor(now() / 60000) * 60000;
        for (const sent of report.buckets) {
          if (sent.at < currentMinute && buckets.get(sent.at)?.revision === sent.revision) buckets.delete(sent.at);
        }
      })
      .catch(() => {
        failures = Math.min(failures + 1, 3);
        nextReport = monotonic() + Math.min(120000, reportMs * 2 ** failures);
      })
      .finally(() => {
        clearTimeout(timeout);
        reportFlight = undefined;
        abort = undefined;
      });
    return reportFlight;
  }

  function schedule() {
    if (stopped) return;
    // Share wall-clock boundaries across containers; delayed ticks never queue.
    timer = setTimeout(
      () => {
        void sample().then(() => {
          void flush();
          schedule();
        });
      },
      sampleMs - (now() % sampleMs),
    );
    timer.unref?.();
  }
  return {
    sample,
    flush,
    start() {
      if (started || stopped) return;
      started = true;
      void sample().then(() => {
        void flush();
        schedule();
      });
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      abort?.abort();
    },
    diagnostics: () => ({ bufferedMinutes: buckets.size, droppedSamples, reportInFlight: !!reportFlight }),
  };
}
