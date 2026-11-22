import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runManagedGateCommand,
  waitForManagedGateCommands,
} from '../../deploy/studio-server/scripts/lib/managed-gate-command.mjs';

// Custom shell for the reusable job. Native Actions still own the DAG, step
// failures and cleanup. No abandoned work can turn into successful deferral.
export async function runHaScript(
  script,
  {
    env = process.env,
    now = Date.now,
    command = runManagedGateCommand,
    settle = waitForManagedGateCommands,
    signal,
    append = fs.appendFile,
    timeout = (ms) => AbortSignal.timeout(ms),
  } = {},
) {
  const phase = env.RIVET_HA_PHASE ?? 'prepare';
  assert.ok(['prepare', 'admission', 'candidate', 'cleanup'].includes(phase), 'Invalid HA phase');
  assert.ok(['early', 'after-gates'].includes(env.RIVET_HA_MODE), 'Invalid HA mode');
  assert.ok(phase !== 'admission' || env.RIVET_HA_MODE === 'early', 'Only early HA needs admission polling');
  if (phase !== 'cleanup' && env.RIVET_HA_MODE === 'early') {
    const deadline = Number(env[phase === 'candidate' ? 'RIVET_HA_ADMITTED_DEADLINE_MS' : 'RIVET_HA_PREP_DEADLINE_MS']);
    assert.ok(Number.isFinite(deadline) && deadline > 0, 'Missing HA phase deadline');
    if (phase !== 'candidate' && (env.RIVET_HA_DEFERRED === 'true' || now() >= deadline)) {
      signal?.throwIfAborted();
      await append(env.GITHUB_ENV, 'RIVET_HA_DEFERRED=true\n');
      console.log('HA preparation deferred before starting another operation');
      return;
    }
    assert.ok(now() < deadline, 'HA admitted-path deadline exceeded');
    // Ordinary preparation has an operation cap. Admission instead uses the
    // original opportunity deadline, plus its bounded ZIP-visibility grace.
    const budget = phase === 'prepare' ? 5 * 60_000 : deadline - now() + (phase === 'admission' ? 70_000 : 0);
    const bounded = timeout(Math.max(1, budget));
    signal = signal ? AbortSignal.any([signal, bounded]) : bounded;
  }
  signal?.throwIfAborted();
  const started = now();
  try {
    await command('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], { env, signal });
  } finally {
    await settle();
    console.log(`HA ${phase} step elapsed: ${now() - started} ms`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort(Error('HA step cancelled'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    await runHaScript(process.argv[2], { signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}
