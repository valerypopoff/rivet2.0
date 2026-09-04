import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS } from '../../../managed-health.js';
import { withManagedPostgresPoolMax } from '../../../managed-postgres-pool.js';
import { createHttpError } from '../../../utils/httpError.js';
import type { ManagedWorkflowStorageConfig } from '../storage-config.js';
import { WORKFLOW_COLUMNS, splitCurrentDraftRevisionRow } from './mappers.js';
import type { ManagedExecutionPointerLookupResult } from './execution-types.js';
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

async function waitForManagedDbRetry(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function getManagedDbConnectionConfig(config: ManagedWorkflowStorageConfig) {
  const sharedConfig = {
    connectionString: config.databaseUrl,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: MANAGED_POSTGRES_CONNECTION_TIMEOUT_MS,
  };

  if (config.databaseSslMode === 'disable') {
    return sharedConfig;
  }

  return {
    ...sharedConfig,
    ssl: {
      rejectUnauthorized: config.databaseSslMode === 'verify-full',
    },
  };
}

export function getManagedDbPoolConfig(config: ManagedWorkflowStorageConfig) {
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

export async function withManagedDbRetry<T>(scope: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MANAGED_DB_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isRetryableManagedDbError(error) || attempt === MANAGED_DB_RETRY_ATTEMPTS) {
        throw error;
      }

      const delayMs = attempt * 250;
      console.warn(
        `[managed-workflows] ${scope} failed with retryable database connection error ` +
          `(${String((error as { code?: unknown }).code ?? 'unknown')}). Retrying in ${delayMs}ms...`,
      );
      await waitForManagedDbRetry(delayMs);
    }
  }

  throw new Error(`[managed-workflows] ${scope} failed without returning a result.`);
}

export async function queryRows<T extends QueryResultRow>(
  client: ManagedWorkflowDbClient,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result =
    client instanceof Pool
      ? await withManagedDbRetry('database query', () => client.query<T>(sql, params))
      : await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  client: ManagedWorkflowDbClient,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(client, sql, params);
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
  ): Promise<ManagedExecutionPointerLookupResult | null>;
};

export function createManagedWorkflowQueries(pool: Pool): ManagedWorkflowQueries {
  return {
    async listFolderRows(client: ManagedWorkflowDbClient = pool): Promise<FolderRow[]> {
      return queryRows<FolderRow>(
        client,
        'SELECT relative_path, name, parent_relative_path, updated_at FROM workflow_folders ORDER BY relative_path ASC',
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
    ): Promise<ManagedExecutionPointerLookupResult | null> {
      if (runKind === 'web-app' || runKind === 'latest-web-app') {
        const row = await queryOne<CurrentDraftRevisionRow & { ui_graph_id: string; allowed_emails: string[] | null }>(
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
              w.last_published_at,
              r.revision_id,
              r.workflow_id AS revision_workflow_id,
              r.project_blob_key,
              r.dataset_blob_key,
              r.stats_graph_count,
              r.stats_total_node_count,
              r.stats_web_app_count,
              r.created_at AS revision_created_at,
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
          },
          revision: split.revision,
        };
      }

      const row = await queryOne<CurrentDraftRevisionRow>(
        client,
        runKind === 'published'
          ? `
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
              w.last_published_at,
              r.revision_id,
              r.workflow_id AS revision_workflow_id,
              r.project_blob_key,
              r.dataset_blob_key,
              r.stats_graph_count,
              r.stats_total_node_count,
              r.stats_web_app_count,
              r.created_at AS revision_created_at
            FROM workflow_endpoints e
            JOIN workflows w ON w.workflow_id = e.workflow_id
            JOIN workflow_revisions r ON r.revision_id = w.published_revision_id
            WHERE e.lookup_name = $1 AND e.is_published = TRUE
          `
          : `
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
              w.last_published_at,
              r.revision_id,
              r.workflow_id AS revision_workflow_id,
              r.project_blob_key,
              r.dataset_blob_key,
              r.stats_graph_count,
              r.stats_total_node_count,
              r.stats_web_app_count,
              r.created_at AS revision_created_at
            FROM workflow_endpoints e
            JOIN workflows w ON w.workflow_id = e.workflow_id
            JOIN workflow_revisions r ON r.revision_id = w.current_draft_revision_id
            WHERE e.lookup_name = $1
              AND e.is_draft = TRUE
              AND w.published_revision_id IS NOT NULL
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
        },
        revision: split.revision,
      };
    },
  };
}
