import { Pool } from 'pg';
import { HostedEvaluationCoordinator } from '../../evaluation-runs/hosted-coordinator.js';
import { PostgresRivetEvaluationStore } from '../../evaluation-runs/managed-store.js';
import { getHostedEvaluationsCoordinatorConfig } from '../../hosted-evaluations-config.js';

if (!process.send || !process.env.HOSTED_EVALUATION_TEST_DATABASE)
  throw new Error('Requires the owned hosted Evaluation test parent');
const database = new URL(process.env.HOSTED_EVALUATION_TEST_DATABASE);
if (
  database.protocol !== 'postgres:' ||
  database.hostname !== '127.0.0.1' ||
  !/^\/(?:hosted_test|rivet_async)$/.test(database.pathname)
) {
  throw new Error('Hosted Evaluation worker requires an owned loopback test database');
}
const pool = new Pool({
  connectionString: database.href,
  connectionTimeoutMillis: 1000,
  application_name: `hosted-test-${process.pid}`,
});
const held = new Set<() => void>();
let closing: Promise<void> | undefined;
const send = (value: unknown) => {
  if (!process.connected) return;
  try {
    process.send!(value, (error: Error | null) => {
      if (error) void finish();
    });
  } catch {
    void finish();
  }
};
const coordinator = new HostedEvaluationCoordinator({
  pool,
  runStore: new PostgresRivetEvaluationStore(pool),
  config: getHostedEvaluationsCoordinatorConfig(
    {
      RIVET_HOSTED_EVALUATIONS_ENABLED: 'true',
      RIVET_HOSTED_EVALUATIONS_LEASE_MS: '15000',
      RIVET_HOSTED_EVALUATIONS_POLL_MS: '250',
    },
    'control',
    true,
  ),
  runGraph: async ({ inputs, metadata, signal }) => {
    send({ event: 'graph', runId: metadata.evaluationRunId, caseId: metadata.caseId });
    if (process.env.HOSTED_EVALUATION_TEST_HOLD === '1') {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          held.delete(release);
          signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason);
        };
        const release = () => {
          cleanup();
          resolve();
        };
        held.add(release);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    return { outputs: { output: inputs.input! }, metrics: { durationMs: 1 } };
  },
});
function close() {
  return (closing ??= (async () => {
    await coordinator.stop();
    await pool.end();
  })());
}
async function finish() {
  try {
    await close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
  if (process.connected) process.disconnect();
}
process.on('message', (message: { id: number; command: 'start' | 'release' | 'retire' | 'shutdown' }) => {
  void (async () => {
    if (message.command === 'start') coordinator.start();
    else if (message.command === 'release') for (const release of [...held.values()]) release();
    else if (message.command === 'retire') await coordinator.drainAcceptedWork();
    else if (message.command === 'shutdown') await close();
    else throw new Error('Unknown hosted worker command');
    send({ id: message.id, result: true });
    if (message.command === 'shutdown') await finish();
  })().catch((error: unknown) => send({ id: message.id, error: String(error) }));
});
process.on('disconnect', () => {
  void finish();
});
process.on('SIGTERM', () => {
  void finish();
});
if (!process.connected) await finish();
else
  send({
    event: 'ready',
    entry: import.meta.url,
    coordinatorEntry: import.meta.resolve('../../evaluation-runs/hosted-coordinator.js'),
    pid: process.pid,
  });
