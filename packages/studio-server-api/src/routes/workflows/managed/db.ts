import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';

import { MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS } from '../../../managed-health.js';
import { withManagedPostgresPoolMax, withAuthoritativePostgresTls } from '../../../managed-postgres-pool.js';
import { createHttpError } from '../../../utils/httpError.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import { WORKFLOW_COLUMNS, splitCurrentDraftRevisionRow } from './mappers.js';
import type { ManagedExecutionPointerLookupResult, ManagedExecutionRevisionRecord, ManagedWebAppAccessPolicy } from './execution-types.js';
import type { CurrentDraftRevisionRow, FolderRow, RevisionRow, WorkflowRow } from './types.js';

export type ManagedWorkflowDbClient = Pool | PoolClient;

const RETRYABLE_MANAGED_DB_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const MANAGED_DB_RETRY_ATTEMPTS = 3;

function isRetryableManagedDbError(error: unknown): boolean {
  if (typeof error !== 'object' || error == null || !('code' in error)) {
    return false;
  }

  return RETRYABLE_MANAGED_DB_ERROR_CODES.has(String((error as { code?: unknown }).code ?? ''));
}

export function getManagedDbConnectionConfig(
  config: Pick<ManagedWorkflowStorageConfig, 'databaseUrl' | 'databaseSslMode'>,
) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
  };

  if (config.databaseSslMode === 'disable') {
    return withAuthoritativePostgresTls({ ...sharedConfig, ssl: false });
  }

  return withAuthoritativePostgresTls({
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  });
}

export function getManagedDbPoolConfig(config: Pick<ManagedWorkflowStorageConfig, 'databaseUrl' | 'databaseSslMode'>) {
  return withManagedPostgresPoolMax(getManagedDbConnectionConfig(config));
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    String((error as { code?: unknown }).code ?? '') === '23505'
  );
}

export async function withManagedDbRetry<T>(scope: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; attempt <= MANAGED_DB_RETRY_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const result = await run();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isRetryableManagedDbError(error) || attempt === MANAGED_DB_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = attempt * 250;
      console.warn(
        `[managed-workflows] ${scope} failed with retryable database connection error ` +
          `(${String((error as { code?: unknown }).code ?? 'unknown')}). Retrying in ${delayMs}ms...`,
      );
      await delay(delayMs, undefined, { signal });
    }
  }

  throw new Error(`[managed-workflows] ${scope} failed without returning a result.`);
}

export async function queryRows<T extends QueryResultRow>(
  client: ManagedWorkflowDbClient,
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T[]> {
  signal?.throwIfAborted();
  const result =
    client instanceof Pool
      ? await withManagedDbRetry('database query', () => client.query<T>(sql, params), signal)
      : await client.query<T>(sql, params);
  signal?.throwIfAborted();
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  client: ManagedWorkflowDbClient,
  sql: string,
  params: unknown[] = [],
  signal?: AbortSignal,
): Promise<T | null> {
  const rows = await queryRows<T>(client, sql, params, signal);
  return rows[0] ?? null;
}

export type ManagedWorkflowQueries = {
  listFolderRows(client?: ManagedWorkflowDbClient): Promise<FolderRow[]>;
  listWorkflowRows(client?: ManagedWorkflowDbClient): Promise<WorkflowRow[]>;
  getWorkflowByRelativePath(
    client: ManagedWorkflowDbClient,
    relativePath: string,
    options?: { forUpdate?: boolean },
  ): Promise<WorkflowRow | null>;
  getWorkflowById(
    client: ManagedWorkflowDbClient,
    workflowId: string,
    options?: { forUpdate?: boolean },
  ): Promise<WorkflowRow | null>;
  getRevision(client: ManagedWorkflowDbClient, revisionId: string | null | undefined): Promise<RevisionRow | null>;
  getCurrentDraftWorkflowRevision(
    client: ManagedWorkflowDbClient,
    relativePath: string,
  ): Promise<{ workflow: WorkflowRow; revision: RevisionRow } | null>;
  ensureFolderChain(client: PoolClient, folderRelativePath: string): Promise<void>;
  assertFolderExists(client: ManagedWorkflowDbClient, folderRelativePath: string): Promise<void>;
  resolveExecutionPointerFromDatabase(
    client: Pool,
    runKind: 'published' | 'latest' | 'web-app' | 'latest-web-app',
    lookupName: string,
    batchPublicLookup?: boolean,
  ): Promise<ManagedExecutionPointerLookupResult | null>;
  resolveWebAppAccessPolicyFromDatabase(client: Pool, lookupName: string): Promise<ManagedWebAppAccessPolicy | null>;
};

export function createManagedWorkflowQueries(pool: Pool): ManagedWorkflowQueries {
  type PointerRow = ManagedExecutionRevisionRecord & {
    lookup_name: string;
    endpoint_workflow_id: string;
    relative_path: string;
    endpoint_access: 'public' | 'internal';
    published_version_id?: string | null;
    history_version_id?: string | null;
    release_id?: string | null;
  };

  function readPointers(client: Pool, published: boolean, names: string | string[]) {
    return queryRows<PointerRow>(
      client,
      `
        SELECT e.lookup_name, w.workflow_id AS endpoint_workflow_id, w.relative_path, w.endpoint_access,
               r.workflow_id, r.revision_id, r.project_blob_key, r.dataset_blob_key, r.created_at
               ${published ? ', w.published_version_id, v.version_id AS history_version_id, v.release_id' : ''}
        FROM workflow_endpoints e
        JOIN workflows w ON w.workflow_id = e.workflow_id
        JOIN workflow_revisions r ON r.revision_id = ${published ? 'w.published_revision_id' : 'w.current_draft_revision_id'}
        ${published ? 'LEFT JOIN workflow_published_versions v ON v.version_id = w.published_version_id AND v.workflow_id = w.workflow_id' : ''}
        WHERE e.lookup_name = ${typeof names === 'string' ? '$1' : 'ANY($1::text[])'}
          AND ${published ? 'e.is_published = TRUE' : 'e.is_draft = TRUE AND w.published_revision_id IS NOT NULL'}
      `,
      [names],
    );
  }

  let pending: { names: Set<string>; rows: Promise<Map<string, PointerRow>> } | undefined;
  let activeReads = 0;

  async function readPublicRows(names: string | string[]) {
    activeReads++;
    try {
      return await readPointers(pool, true, names);
    } finally {
      activeReads--;
    }
  }

  async function readFreshPublicPointer(name: string) {
    if (!activeReads && !pending) return (await readPublicRows(name))[0];
    if (!pending) {
      const names = new Set<string>();
      const rows = nextTurn().then(async () => {
        // Close enrollment before issuing SQL. Later callers must see a new snapshot.
        pending = undefined;
        const keys = [...names];
        const result = await readPublicRows(keys.length === 1 ? keys[0]! : keys);
        return new Map(result.map((row) => [row.lookup_name, row]));
      });
      pending = { names, rows };
    }
    pending.names.add(name);
    return (await pending.rows).get(name);
  }

  return {
    async listFolderRows(client: ManagedWorkflowDbClient = pool): Promise<FolderRow[]> {
      return queryRows<FolderRow>(
        client,
        'SELECT relative_path, name, parent_relative_path, updated_at, bundle_id, namespace_id FROM workflow_folders ORDER BY relative_path ASC',
      );
    },

    async listWorkflowRows(client: ManagedWorkflowDbClient = pool): Promise<WorkflowRow[]> {
      return queryRows<WorkflowRow>(
        client,
        `
        SELECT ${WORKFLOW_COLUMNS}
        FROM workflows
        ORDER BY relative_path ASC
      `,
      );
    },

    async getWorkflowByRelativePath(
      client: ManagedWorkflowDbClient,
      relativePath: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<WorkflowRow | null> {
      return queryOne<WorkflowRow>(
        client,
        `
          SELECT ${WORKFLOW_COLUMNS}
          FROM workflows
          WHERE relative_path = $1
          ${options.forUpdate ? 'FOR UPDATE' : ''}
        `,
        [relativePath],
      );
    },

    async getWorkflowById(
      client: ManagedWorkflowDbClient,
      workflowId: string,
      options: { forUpdate?: boolean } = {},
    ): Promise<WorkflowRow | null> {
      return queryOne<WorkflowRow>(
        client,
        `
          SELECT ${WORKFLOW_COLUMNS}
          FROM workflows
          WHERE workflow_id = $1
          ${options.forUpdate ? 'FOR UPDATE' : ''}
        `,
        [workflowId],
      );
    },

    async getRevision(
      client: ManagedWorkflowDbClient,
      revisionId: string | null | undefined,
    ): Promise<RevisionRow | null> {
      if (!revisionId) {
        return null;
      }

      return queryOne<RevisionRow>(
        client,
        `
          SELECT revision_id, workflow_id, project_blob_key, dataset_blob_key, stats_graph_count, stats_total_node_count, stats_web_app_count, created_at
          FROM workflow_revisions
          WHERE revision_id = $1
        `,
        [revisionId],
      );
    },

    async getCurrentDraftWorkflowRevision(
      client: ManagedWorkflowDbClient,
      relativePath: string,
    ): Promise<{ workflow: WorkflowRow; revision: RevisionRow } | null> {
      const row = await queryOne<CurrentDraftRevisionRow>(
        client,
        `
          SELECT
            w.workflow_id,
            w.name,
            w.file_name,
            w.relative_path,
            w.folder_relative_path,
            w.updated_at,
            w.current_draft_revision_id,
            w.published_revision_id,
            w.published_version_id,
            w.endpoint_name,
            w.published_endpoint_name,
            w.endpoint_access,
            w.last_published_at,
            r.revision_id,
            r.workflow_id AS revision_workflow_id,
            r.project_blob_key,
            r.dataset_blob_key,
            r.stats_graph_count,
            r.stats_total_node_count,
            r.stats_web_app_count,
            r.created_at AS revision_created_at
          FROM workflows w
          JOIN workflow_revisions r ON r.revision_id = w.current_draft_revision_id
          WHERE w.relative_path = $1
        `,
        [relativePath],
      );

      return row ? splitCurrentDraftRevisionRow(row) : null;
    },

    async ensureFolderChain(client: PoolClient, folderRelativePath: string): Promise<void> {
      if (!folderRelativePath) {
        return;
      }

      const segments = folderRelativePath.split('/');
      for (let index = 0; index < segments.length; index += 1) {
        const relativePath = segments.slice(0, index + 1).join('/');
        const parentRelativePath = segments.slice(0, index).join('/');
        await client.query(
          `
            INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (relative_path) DO UPDATE SET
              name = EXCLUDED.name,
              parent_relative_path = EXCLUDED.parent_relative_path
          `,
          [relativePath, segments[index], parentRelativePath],
        );
      }
    },

    async assertFolderExists(client: ManagedWorkflowDbClient, folderRelativePath: string): Promise<void> {
      if (!folderRelativePath) {
        return;
      }

      const row = await queryOne<{ relative_path: string }>(
        client,
        'SELECT relative_path FROM workflow_folders WHERE relative_path = $1',
        [folderRelativePath],
      );
      if (!row) {
        throw createHttpError(404, 'Folder not found');
      }
    },

    async resolveExecutionPointerFromDatabase(
      client: Pool,
      runKind: 'published' | 'latest' | 'web-app' | 'latest-web-app',
      lookupName: string,
      batchPublicLookup = false,
    ): Promise<ManagedExecutionPointerLookupResult | null> {
      if (runKind === 'web-app' || runKind === 'latest-web-app') {
        const row = await queryOne<
          CurrentDraftRevisionRow & {
            ui_graph_id: string;
            allowed_emails: string[] | null;
            web_app_id: string;
          }
        >(
          client,
          `
            SELECT
              w.workflow_id,
              w.name,
              w.file_name,
              w.relative_path,
              w.folder_relative_path,
              w.updated_at,
              w.current_draft_revision_id,
              w.published_revision_id,
              w.published_version_id,
              w.endpoint_name,
              w.published_endpoint_name,
              w.endpoint_access,
              w.last_published_at,
              r.revision_id,
              r.workflow_id AS revision_workflow_id,
              r.project_blob_key,
              r.dataset_blob_key,
              r.stats_graph_count,
              r.stats_total_node_count,
              r.stats_web_app_count,
              r.created_at AS revision_created_at,
              app.app_id AS web_app_id,
              app.ui_graph_id,
              app.allowed_emails
            FROM workflow_web_apps app
            JOIN workflows w ON w.workflow_id = app.workflow_id
            JOIN workflow_revisions r ON r.revision_id = ${
              runKind === 'web-app' ? 'app.revision_id' : 'w.current_draft_revision_id'
            }
            WHERE app.slug_lookup_name = $1
          `,
          [lookupName],
        );
        if (!row) {
          return null;
        }

        const split = splitCurrentDraftRevisionRow(row);
        return {
          pointer: {
            workflowId: split.workflow.workflow_id,
            relativePath: split.workflow.relative_path,
            revisionId: split.revision.revision_id,
            webAppUiGraphId: row.ui_graph_id,
            webAppAllowedEmails: row.allowed_emails ?? [],
            webAppId: row.web_app_id,
          },
          revision: split.revision,
        };
      }

      const published = runKind === 'published';
      const row = published && batchPublicLookup && client === pool
        ? await readFreshPublicPointer(lookupName)
        : (await readPointers(client, published, lookupName))[0];
      if (!row) return null;
      if (row.published_version_id && row.history_version_id === null)
        throw createHttpError(503, 'The active endpoint revision is missing from history.');
      return {
        pointer: {
          workflowId: row.endpoint_workflow_id,
          relativePath: row.relative_path,
          revisionId: row.revision_id,
          endpointAccess: row.endpoint_access ?? 'public',
          ...(row.release_id ? { releaseId: row.release_id } : {}),
        },
        revision: {
          revision_id: row.revision_id,
          workflow_id: row.workflow_id,
          project_blob_key: row.project_blob_key,
          dataset_blob_key: row.dataset_blob_key,
          created_at: row.created_at,
        },
      };
    },

    async resolveWebAppAccessPolicyFromDatabase(
      client: Pool,
      lookupName: string,
    ): Promise<ManagedWebAppAccessPolicy | null> {
      const row = await queryOne<{
        app_id: string;
        relative_path: string;
        ui_graph_id: string;
        allowed_emails: string[] | null;
      }>(
        client,
        `
          SELECT app.app_id, w.relative_path, app.ui_graph_id, app.allowed_emails
          FROM workflow_web_apps app
          JOIN workflows w ON w.workflow_id = app.workflow_id
          WHERE app.slug_lookup_name = $1
        `,
        [lookupName],
      );
      return row == null
        ? null
        : {
            appId: row.app_id,
            relativePath: row.relative_path,
            uiGraphId: row.ui_graph_id,
            allowedEmails: row.allowed_emails ?? [],
          };
    },
  };
}
