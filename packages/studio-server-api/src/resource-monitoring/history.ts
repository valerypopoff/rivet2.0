import type {
  ResourceHistoryPoint,
  ResourcePeriod,
  ResourceSample,
  ResourceStatistics,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';

export const RESOURCE_PERIODS: Record<ResourcePeriod, { duration: number; step: number }> = {
  '1h': { duration: 3600000, step: 60000 },
  '24h': { duration: 86400000, step: 300000 },
  '7d': { duration: 604800000, step: 1800000 },
};

/** Mergeable minute histograms keep long-range reads off individual samples. */
export function summarizeResourceSamples(
  samples: readonly Pick<ResourceSample, 'durationMs' | 'cpuMillicores' | 'memoryBytes' | 'workingSetBytes'>[],
) {
  const summary: Record<string, Record<string, { weight: number; sum: number; peak: number }>> = {};
  for (const [field, key] of [
    ['cpu', 'cpuMillicores'],
    ['memory', 'memoryBytes'],
    ['workingSet', 'workingSetBytes'],
  ] as const) {
    const bins: (typeof summary)[string] = {};
    summary[field] = bins;
    for (const sample of samples) {
      const value = sample[key],
        weight = sample.durationMs;
      if (value === null) continue;
      const upper = value === 0 ? 0 : Math.pow(1.05, Math.ceil(Math.log(value) / Math.log(1.05)));
      const bin = (bins[String(upper)] ??= { weight: 0, sum: 0, peak: 0 });
      bin.weight += weight;
      bin.sum += value * weight;
      bin.peak = Math.max(bin.peak, value);
    }
  }
  return summary;
}

export function resourceStatistics(raw?: {
  sum: number;
  weight: number;
  peak: number;
  histogram: Record<string, number>;
}): ResourceStatistics {
  if (!raw) return { average: null, p95: null, peak: null, coverageMs: 0 };
  if (!raw.weight) return { average: null, p95: null, peak: raw.peak, coverageMs: 0 };
  const bins = Object.entries(raw.histogram ?? {})
    .map(([value, weight]) => [Number(value), Number(weight)] as const)
    .sort((a, b) => a[0] - b[0]);
  let cumulative = 0,
    percentile: number | null = null;
  for (const [upper, weight] of bins) {
    cumulative += weight;
    if (cumulative >= raw.weight * 0.95) {
      percentile = Math.min(raw.peak, upper);
      break;
    }
  }
  return { average: raw.sum / raw.weight, p95: percentile, peak: raw.peak, coverageMs: raw.weight };
}

/** Explicit null points stop charts joining across missing reporting intervals. */
export function fillResourceHistory(
  points: ResourceHistoryPoint[],
  from: number,
  to: number,
  step: number,
): ResourceHistoryPoint[] {
  const byTime = new Map(points.map((p) => [p.at, p]));
  const result: ResourceHistoryPoint[] = [];
  for (let at = Math.floor(from / step) * step; at <= to; at += step) {
    result.push(
      byTime.get(at) ?? {
        at,
        cpuMillicores: null,
        memoryBytes: null,
        workingSetBytes: null,
        activeRuns: null,
        runLimit: null,
        reporters: 0,
        complete: false,
      },
    );
  }
  return result;
}
