import type { RuntimeLibraryReplicaCleanupResult } from '../../../../shared/runtime-library-types.js';
import { getRuntimeLibraryReplicaHeartbeatTtlMs, queryRows } from './schema.js';
import type { ManagedRuntimeLibrariesContext } from './context.js';

export async function clearManagedRuntimeLibraryStaleReplicaStatuses(
  context: ManagedRuntimeLibrariesContext,
): Promise<RuntimeLibraryReplicaCleanupResult> {
  const heartbeatTtlMs = getRuntimeLibraryReplicaHeartbeatTtlMs(context.config.syncPollIntervalMs);
  const staleBefore = new Date(Date.now() - heartbeatTtlMs).toISOString();
  const rows = await queryRows<{ replica_id: string }>(
    context.pool,
    `
      DELETE FROM runtime_library_replica_status
      WHERE last_heartbeat_at < NOW() - ($1 * INTERVAL '1 millisecond')
      RETURNING replica_id
    `,
    [heartbeatTtlMs],
  );

  return {
    deletedReplicaCount: rows.length,
    deletedReplicaIds: rows.map((row) => row.replica_id),
    staleBefore,
  };
}
