import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { createManagedWorkflowEndpointSync } from '../routes/workflows/managed/endpoint-sync.js';
import type { WorkflowRow } from '../routes/workflows/managed/types.js';

type EndpointRow = {
  lookup_name: string;
  workflow_id: string;
  endpoint_name: string;
  is_draft: boolean;
  is_published: boolean;
};

type WorkflowEndpointState = {
  endpointName: string;
  publishedEndpointName: string;
  publishedRevisionId: string | null;
};

class FakeEndpointSyncClient {
  readonly endpointRows = new Map<string, EndpointRow>();
  readonly workflowEndpointStates = new Map<string, WorkflowEndpointState>([
    ['workflow-a', {
      endpointName: '',
      publishedEndpointName: '',
      publishedRevisionId: 'revision-a',
    }],
    ['workflow-b', {
      endpointName: '',
      publishedEndpointName: '',
      publishedRevisionId: 'revision-b',
    }],
  ]);

  seed(row: EndpointRow): void {
    this.endpointRows.set(row.lookup_name, row);
    const state = this.getWorkflowEndpointState(row.workflow_id);
    this.workflowEndpointStates.set(row.workflow_id, {
      ...state,
      endpointName: row.is_draft ? row.endpoint_name : state.endpointName,
      publishedEndpointName: row.is_published ? row.endpoint_name : state.publishedEndpointName,
    });
  }

  setWorkflowEndpointNames(workflowId: string, endpointName: string, publishedEndpointName: string): void {
    const state = this.getWorkflowEndpointState(workflowId);
    this.workflowEndpointStates.set(workflowId, {
      ...state,
      endpointName,
      publishedEndpointName,
    });
  }

  setWorkflowPublishedRevisionId(workflowId: string, revisionId: string | null): void {
    const state = this.getWorkflowEndpointState(workflowId);
    this.workflowEndpointStates.set(workflowId, {
      ...state,
      publishedRevisionId: revisionId,
    });
  }

  private getWorkflowEndpointState(workflowId: string): WorkflowEndpointState {
    return this.workflowEndpointStates.get(workflowId) ?? {
      endpointName: '',
      publishedEndpointName: '',
      publishedRevisionId: null,
    };
  }

  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (sql === 'SELECT workflow_id FROM workflow_endpoints WHERE lookup_name = $1') {
      const lookupName = String(values[0] ?? '');
      const row = this.endpointRows.get(lookupName);
      return {
        rows: row ? [{ workflow_id: row.workflow_id }] : [],
      };
    }

    if (sql === 'SELECT lookup_name FROM workflow_endpoints WHERE workflow_id = $1') {
      const workflowId = String(values[0] ?? '');
      return {
        rows: [...this.endpointRows.values()]
          .filter((row) => row.workflow_id === workflowId)
          .map((row) => ({ lookup_name: row.lookup_name })),
      };
    }

    if (sql.includes('INSERT INTO workflow_endpoints')) {
      const [lookupName, workflowId, endpointName, isDraft, isPublished] = values as [
        string,
        string,
        string,
        boolean,
        boolean,
      ];
      const existingRow = this.endpointRows.get(lookupName);
      if (existingRow && existingRow.workflow_id !== workflowId) {
        return { rows: [] };
      }

      this.endpointRows.set(lookupName, {
        lookup_name: lookupName,
        workflow_id: workflowId,
        endpoint_name: endpointName,
        is_draft: isDraft,
        is_published: isPublished,
      });
      return { rows: [{ workflow_id: workflowId }] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE workflow_id = $1') {
      const workflowId = String(values[0] ?? '');
      for (const [lookupName, row] of this.endpointRows.entries()) {
        if (row.workflow_id === workflowId) {
          this.endpointRows.delete(lookupName);
        }
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE workflow_id = $1 AND lookup_name <> ALL($2::text[])') {
      const workflowId = String(values[0] ?? '');
      const desiredLookupNames = new Set((values[1] as string[]) ?? []);
      for (const [lookupName, row] of this.endpointRows.entries()) {
        if (row.workflow_id === workflowId && !desiredLookupNames.has(lookupName)) {
          this.endpointRows.delete(lookupName);
        }
      }
      return { rows: [] };
    }

    if (
      sql === 'DELETE FROM workflow_endpoints e WHERE e.lookup_name = $1 AND e.workflow_id = $2 ' +
      'AND NOT EXISTS ( SELECT 1 FROM workflows w WHERE w.workflow_id = e.workflow_id ' +
      'AND w.published_revision_id IS NOT NULL AND ( LOWER(w.endpoint_name) = e.lookup_name ' +
      'OR LOWER(w.published_endpoint_name) = e.lookup_name ) )'
    ) {
      const lookupName = String(values[0] ?? '');
      const workflowId = String(values[1] ?? '');
      const row = this.endpointRows.get(lookupName);
      const state = this.getWorkflowEndpointState(workflowId);
      const activeLookupNames = new Set([
        state.endpointName.toLowerCase(),
        state.publishedEndpointName.toLowerCase(),
      ]);
      if (
        row?.workflow_id === workflowId &&
        (state.publishedRevisionId == null || !activeLookupNames.has(lookupName))
      ) {
        this.endpointRows.delete(lookupName);
      }
      return { rows: [] };
    }

    if (sql === 'DELETE FROM workflow_endpoints WHERE lookup_name = $1 AND workflow_id = $2') {
      const lookupName = String(values[0] ?? '');
      const workflowId = String(values[1] ?? '');
      const row = this.endpointRows.get(lookupName);
      if (row?.workflow_id === workflowId) {
        this.endpointRows.delete(lookupName);
      }
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in fake endpoint client: ${sql}`);
  }
}

function createWorkflowRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: new Date().toISOString(),
    current_draft_revision_id: 'revision-a',
    published_revision_id: 'revision-a',
    published_version_id: 'version-a',
    endpoint_name: '',
    published_endpoint_name: '',
    last_published_at: null,
    ...overrides,
  };
}

test('draft and published endpoint names with the same normalized lookup collapse to one row', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'Hello-World',
      publishedEndpointName: 'hello-world',
    },
  );

  assert.equal(client.endpointRows.size, 1);
  assert.deepEqual(client.endpointRows.get('hello-world'), {
    lookup_name: 'hello-world',
    workflow_id: 'workflow-a',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: true,
  });
});

test('published endpoint conflicts throw a 409', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: false,
    is_published: true,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await assert.rejects(
    endpointSync.syncWorkflowEndpointRows(
      client as unknown as PoolClient,
      createWorkflowRow(),
      {
        draftEndpointName: 'Hello-World',
        publishedEndpointName: 'Hello-World',
      },
    ),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String((error as Error).message), /already used by another workflow/);
      return true;
    },
  );
});

test('active latest endpoint conflicts throw a 409', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await assert.rejects(
    endpointSync.syncWorkflowEndpointRows(
      client as unknown as PoolClient,
      createWorkflowRow(),
      {
        draftEndpointName: 'Hello-World',
        publishedEndpointName: 'current-public',
      },
    ),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String((error as Error).message), /already used by another workflow/);
      return true;
    },
  );
});

test('draft-only endpoint names do not reserve managed endpoint rows', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'saved-draft-endpoint',
      publishedEndpointName: '',
    },
  );

  assert.equal(client.endpointRows.size, 0);
});

test('sync removes owned endpoint rows when only a saved unpublished draft remains', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'old-draft',
    workflow_id: 'workflow-a',
    endpoint_name: 'old-draft',
    is_draft: true,
    is_published: false,
  });
  client.seed({
    lookup_name: 'old-public',
    workflow_id: 'workflow-a',
    endpoint_name: 'old-public',
    is_draft: false,
    is_published: true,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'old-draft',
      publishedEndpointName: '',
    },
  );

  assert.deepEqual(
    [...client.endpointRows.values()].filter((row) => row.workflow_id === 'workflow-a'),
    [],
  );
});

test('stale endpoint rows owned by fully unpublished workflows are reclaimed', async () => {
  const client = new FakeEndpointSyncClient();
  client.setWorkflowPublishedRevisionId('workflow-b', null);
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'Hello-World',
      publishedEndpointName: 'Hello-World',
    },
  );

  assert.deepEqual(client.endpointRows.get('hello-world'), {
    lookup_name: 'hello-world',
    workflow_id: 'workflow-a',
    endpoint_name: 'Hello-World',
    is_draft: true,
    is_published: true,
  });
});

test('stale endpoint rows for workflows published elsewhere are reclaimed', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'old-endpoint',
    workflow_id: 'workflow-b',
    endpoint_name: 'old-endpoint',
    is_draft: true,
    is_published: false,
  });
  client.setWorkflowEndpointNames('workflow-b', 'current-draft', 'current-public');

  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'Old-Endpoint',
      publishedEndpointName: 'Old-Endpoint',
    },
  );

  assert.deepEqual(client.endpointRows.get('old-endpoint'), {
    lookup_name: 'old-endpoint',
    workflow_id: 'workflow-a',
    endpoint_name: 'Old-Endpoint',
    is_draft: true,
    is_published: true,
  });
});

test('stale endpoint rows are not reclaimed after the old owner republishes', async () => {
  const client = new FakeEndpointSyncClient();
  client.setWorkflowPublishedRevisionId('workflow-b', null);
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });

  const endpointSync = createManagedWorkflowEndpointSync();
  const originalQuery = client.query.bind(client);
  let oldOwnerRepublished = false;

  client.query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (
      !oldOwnerRepublished &&
      sql.startsWith('DELETE FROM workflow_endpoints e WHERE e.lookup_name = $1')
    ) {
      oldOwnerRepublished = true;
      client.setWorkflowPublishedRevisionId('workflow-b', 'revision-b');
    }

    return originalQuery(text, values);
  };

  await assert.rejects(
    endpointSync.syncWorkflowEndpointRows(
      client as unknown as PoolClient,
      createWorkflowRow(),
      {
        draftEndpointName: 'Hello-World',
        publishedEndpointName: 'Hello-World',
      },
    ),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String((error as Error).message), /already used by another workflow/);
      return true;
    },
  );

  assert.deepEqual(client.endpointRows.get('hello-world'), {
    lookup_name: 'hello-world',
    workflow_id: 'workflow-b',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });
});

test('endpoint upsert does not overwrite a different workflow that claims the lookup concurrently', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  const originalQuery = client.query.bind(client);
  let insertedConcurrentOwner = false;
  client.query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (
      !insertedConcurrentOwner &&
      sql.includes('INSERT INTO workflow_endpoints')
    ) {
      insertedConcurrentOwner = true;
      client.seed({
        lookup_name: 'race-endpoint',
        workflow_id: 'workflow-b',
        endpoint_name: 'race-endpoint',
        is_draft: true,
        is_published: true,
      });
    }

    return originalQuery(text, values);
  };

  await assert.rejects(
    endpointSync.syncWorkflowEndpointRows(
      client as unknown as PoolClient,
      createWorkflowRow(),
      {
        draftEndpointName: 'race-endpoint',
        publishedEndpointName: 'race-endpoint',
      },
    ),
    (error: unknown) => {
      assert.equal(typeof error, 'object');
      assert.equal((error as { status?: number }).status, 409);
      assert.match(String((error as Error).message), /already used by another workflow/);
      return true;
    },
  );

  assert.equal(client.endpointRows.get('race-endpoint')?.workflow_id, 'workflow-b');
});

test('removing all desired endpoints deletes all rows owned by the workflow', async () => {
  const client = new FakeEndpointSyncClient();
  client.seed({
    lookup_name: 'hello-world',
    workflow_id: 'workflow-a',
    endpoint_name: 'hello-world',
    is_draft: true,
    is_published: false,
  });
  client.seed({
    lookup_name: 'main-live',
    workflow_id: 'workflow-a',
    endpoint_name: 'main-live',
    is_draft: false,
    is_published: true,
  });

  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: '',
      publishedEndpointName: '',
    },
  );

  assert.deepEqual(
    [...client.endpointRows.values()].filter((row) => row.workflow_id === 'workflow-a'),
    [],
  );
});

test('distinct draft and published endpoints preserve their own visibility flags', async () => {
  const client = new FakeEndpointSyncClient();
  const endpointSync = createManagedWorkflowEndpointSync();

  await endpointSync.syncWorkflowEndpointRows(
    client as unknown as PoolClient,
    createWorkflowRow(),
    {
      draftEndpointName: 'latest-only',
      publishedEndpointName: 'public-live',
    },
  );

  assert.deepEqual(client.endpointRows.get('latest-only'), {
    lookup_name: 'latest-only',
    workflow_id: 'workflow-a',
    endpoint_name: 'latest-only',
    is_draft: true,
    is_published: false,
  });
  assert.deepEqual(client.endpointRows.get('public-live'), {
    lookup_name: 'public-live',
    workflow_id: 'workflow-a',
    endpoint_name: 'public-live',
    is_draft: false,
    is_published: true,
  });
});
