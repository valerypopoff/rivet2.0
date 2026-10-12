import pg from 'pg';
import { getManagedRuntimeLibrariesConfig, getManagedRuntimeLibrariesPoolConfig } from './config.mjs';

export function blocksRestoreServing(journal) {
  return (
    journal &&
    !['uploading', 'validating', 'awaiting-confirmation', 'completed', 'cancelled'].includes(journal.phase) &&
    (journal.phase !== 'failed' || journal.destructive)
  );
}

/** Editor executor participates before its runtime-library sync or WebSocket listener starts. */
export async function startRestoreParticipant(settings, disposeRuntime, createPool = (config) => new pg.Pool(config)) {
  const pool = createPool({
    ...getManagedRuntimeLibrariesPoolConfig(getManagedRuntimeLibrariesConfig(settings)),
    max: 2,
  });
  let client;
  const read = async () => {
    const present = (await pool.query("SELECT to_regclass('rivet_restore_control.operation') AS name")).rows[0]?.name;
    if (present) {
      const owner = (await pool.query('SELECT deployment FROM rivet_restore_control.installation WHERE singleton=TRUE'))
        .rows[0]?.deployment;
      if (owner !== process.env.RIVET_LEGACY_RESTORE_INSTALLATION)
        throw new Error('Restore catalog belongs to a different deployment.');
    }
    return present
      ? (await pool.query('SELECT journal FROM rivet_restore_control.operation WHERE singleton=TRUE')).rows[0]?.journal
      : null;
  };
  let held = false;
  let closing = false;
  let busy = false;
  let initial;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock_shared($1,$2)', [8072, 24004]);
    held = true;
    initial = await read();
    globalThis.__rivetLegacyRestorePaused = initial?.phase === 'restarting';
    if (blocksRestoreServing(initial) && initial.phase !== 'restarting')
      throw new Error('Legacy restore blocks executor startup.');
  } catch (error) {
    client?.release(true);
    await pool.end();
    throw error;
  }
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (!held) return;
      globalThis.__rivetLegacyRestorePaused = true;
      while ((globalThis.__rivetLegacyRestoreEditorActivity?.() ?? 0) > 0)
        await new Promise((resolve) => setTimeout(resolve, 250));
      await disposeRuntime();
      await client.query('SELECT pg_advisory_unlock_shared($1,$2)', [8072, 24004]);
      held = false;
    })());
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .then(async (journal) => {
        if (closing) return;
        if (blocksRestoreServing(journal) && journal.phase !== 'restarting') await stop();
        // The co-located API requests the supervisor-owned restart after verification/completion.
        // Self-termination here can win that race and be treated as an unexpected child crash,
        // killing the API/worker before its restart acknowledgement. Remain fenced meanwhile.
        else if (!held || (initial?.phase === 'restarting' && journal?.phase === 'completed'))
          globalThis.__rivetLegacyRestorePaused = true;
      })
      .catch(() => {
        if (closing) return;
        globalThis.__rivetLegacyRestorePaused = true;
        process.kill(process.pid, 'SIGTERM');
      })
      .finally(() => {
        busy = false;
      });
  }, 1000);
  timer.unref();
  const onLeaseError = () => {
    if (!held) return;
    globalThis.__rivetLegacyRestorePaused = true;
    // The writer lease is already gone. Graceful drain would allow accepted work to keep writing
    // while the restorer holds exclusive ownership; this generation must stop immediately.
    process.exit(1);
  };
  client.on('error', onLeaseError);
  let disposal;
  const dispose = () =>
    (disposal ??= (async () => {
      closing = true;
      clearInterval(timer);
      process.off('SIGTERM', onTermination);
      await stop(); // A failed drain retains its lease; process termination is not an acknowledgement.
      client.off('error', onLeaseError);
      client.release();
      await pool.end();
    })());
  const onTermination = () =>
    void dispose().catch(() => {
      process.exitCode = 1;
    });
  process.once('SIGTERM', onTermination);
  return dispose;
}
