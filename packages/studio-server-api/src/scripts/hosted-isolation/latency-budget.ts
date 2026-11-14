export type LatencyBudgetResult = {
  samplesPerPath: number;
  directP95Ms: number;
  isolatedP95Ms: number;
  addedP95Ms: number;
  limitMs: number;
  status: 'met' | 'exceeded' | 'insufficient-evidence';
};

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw new Error('Latency samples must be nonempty, finite and nonnegative.');
  if (!(fraction > 0 && fraction <= 1)) throw new Error('Invalid latency percentile.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

/** Workload latency only; not capacity/compatibility qualification. Require
 * sufficient matched observations instead of accepting a three-sample tail. */
export function evaluateLatencyBudget(
  direct: readonly number[],
  isolated: readonly number[],
  limitMs: number,
): LatencyBudgetResult {
  if (!Number.isFinite(limitMs) || limitMs < 0) throw new Error('Invalid latency budget.');
  const directP95Ms = percentile(direct, 0.95);
  const isolatedP95Ms = percentile(isolated, 0.95);
  const addedP95Ms = isolatedP95Ms - directP95Ms;
  return {
    samplesPerPath: Math.min(direct.length, isolated.length),
    directP95Ms,
    isolatedP95Ms,
    addedP95Ms,
    limitMs,
    status:
      direct.length !== isolated.length || direct.length < 200
        ? 'insufficient-evidence'
        : addedP95Ms <= limitMs
          ? 'met'
          : 'exceeded',
  };
}
