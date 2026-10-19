import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { validateManagedSubgraphTarget } from '../routes/workflows/managed/subgraph-access.js';

test('bundle encapsulation permits same-bundle and ordinary targets but rejects outside callers', async () => {
  const query = {
    projectId: 'target' as ProjectId,
    version: 'latest' as const,
    callerProjectId: 'caller' as ProjectId,
  };
  for (const [bundle, callerBundle, allowed] of [
    [null, null, true],
    [null, 'one', true],
    ['one', 'one', true],
    ['one', null, false],
    ['one', 'two', false],
  ] as const) {
    let reads = 0;
    const pool = {
      query: async (_sql: string, args: unknown[]) => {
        reads++;
        assert.deepEqual(args, ['target', 'caller']);
        return { rows: [{ bundle_id: bundle, caller_bundle_id: callerBundle }] };
      },
    } as unknown as Pool;
    if (allowed) await validateManagedSubgraphTarget(pool, query);
    else await assert.rejects(validateManagedSubgraphTarget(pool, query), { status: 403 });
    assert.equal(reads, 1, 'one live membership snapshot, without reading project blobs');
  }
  await assert.rejects(validateManagedSubgraphTarget({ query: async () => ({ rows: [] }) } as unknown as Pool, query), {
    status: 404,
  });
});
