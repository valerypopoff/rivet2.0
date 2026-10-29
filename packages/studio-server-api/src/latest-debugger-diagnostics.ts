import { recordStudioMetrics } from './metrics.js';

type Reason = 'ownership' | 'broadcast' | 'history' | 'unavailable';
/** Finite metadata only; telemetry is never execution authority. */
export function createLatestDebuggerReporter(
  warn: (entry: { event: string; reason: Reason; count: number }) => void = (entry) =>
    console.warn(JSON.stringify(entry)),
  now: () => number = Date.now,
) {
  const states = new Map<Reason, { count: number; last: number }>();
  return (reason: Reason) => {
    try {
      recordStudioMetrics((metrics) => metrics.recordLatestDebuggerDiagnostic(reason));
      const state = states.get(reason) ?? { count: 0, last: -Infinity };
      state.count++;
      states.set(reason, state);
      if (now() - state.last < 60_000) return;
      state.last = now();
      warn({ event: 'latest-debugger-diagnostic', reason, count: state.count });
    } catch {
      /* Observability must never affect accepted work. */
    }
  };
}
