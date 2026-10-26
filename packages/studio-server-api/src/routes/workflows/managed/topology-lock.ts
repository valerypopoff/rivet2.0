import type { PoolClient } from 'pg';

/** Shared lock order: topology lease before any folder/workflow row locks. */
export const lockBundleTopology = (client: PoolClient) => client.query('SELECT pg_advisory_xact_lock(8071, 24016)');
