import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';

/** Diagnostics only: never changes a deadline, retries work or retains errors. */
export function createHaProofTiming({
  artifact,
  log = console.log,
  now = () => performance.now(),
  heartbeatMs = 30_000,
}) {
  const started = now();
  const phases = [];
  const active = new Map();
  let status = 'starting';
  let closed = false;
  const snapshot = () => ({ version: 1, elapsedMs: Math.round(now() - started), status, phases });
  const heartbeat = setInterval(() => {
    log(
      `[ha-progress] ${status}; ${Math.round((now() - started) / 1000)}s elapsed; active: ${[...active.keys()].join(', ') || 'none'}`,
    );
  }, heartbeatMs);
  heartbeat.unref();
  const save = async () => {
    try {
      await artifact('ha-timing.json', `${JSON.stringify(snapshot(), null, 2)}\n`);
    } catch {
      log('[ha-progress] Timing artifact unavailable; behavioral result is unchanged.');
    }
  };
  return {
    status(value) {
      status = value;
    },
    async measure(name, action) {
      if (closed || phases.length >= 256 || active.has(name)) throw Error('Invalid HA timing phase lifetime.');
      const phase = { name, startedMs: Math.round(now() - started), outcome: 'running' };
      phases.push(phase);
      active.set(name, phase);
      log(`[ha-phase] Starting ${name}`);
      try {
        const result = await action();
        phase.outcome = 'passed';
        return result;
      } catch (error) {
        phase.outcome = 'failed';
        throw error;
      } finally {
        phase.elapsedMs = Math.round(now() - started - phase.startedMs);
        active.delete(name);
        log(`[ha-phase] ${name}: ${phase.outcome} (${phase.elapsedMs}ms)`);
        await save();
      }
    },
    async close() {
      clearInterval(heartbeat);
      closed = true;
      await save();
      return snapshot();
    },
  };
}

export const measureHaPhase = (gate, name, action) =>
  gate.proofTiming ? gate.proofTiming.measure(name, action) : action();

export async function summarizeHaTiming(summary, scenario, timing) {
  if (!summary) return;
  const lines = [
    `### HA scenario: ${scenario}`,
    '',
    '| Phase | Outcome | Seconds |',
    '| --- | --- | ---: |',
    ...timing.phases.map((p) => `| ${p.name} | ${p.outcome} | ${(p.elapsedMs / 1000).toFixed(1)} |`),
    '',
    `Scenario elapsed: ${(timing.elapsedMs / 1000).toFixed(1)}s. Cluster creation/cleanup and runner setup are reported separately by GitHub.`,
    '',
  ];
  try {
    await fs.appendFile(summary, lines.join('\n'));
  } catch {
    console.log('[ha-progress] Could not append the timing summary; behavioral result is unchanged.');
  }
}
