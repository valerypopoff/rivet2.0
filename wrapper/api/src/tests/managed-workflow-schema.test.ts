import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { createManagedWorkflowQueries } from '../routes/workflows/managed/db.js';
import { MANAGED_WORKFLOW_SCHEMA_SQL } from '../routes/workflows/managed/schema.js';

function createExecutionLookupRow() {
  return {
    workflow_id: 'workflow-a',
    name: 'Main',
    file_name: 'Main.rivet-project',
    relative_path: 'Main.rivet-project',
    folder_relative_path: '',
    updated_at: new Date().toISOString(),
    current_draft_revision_id: 'draft-revision',
    published_revision_id: 'published-revision',
    published_version_id: 'published-version',
    endpoint_name: 'latest-only',
    published_endpoint_name: 'public-live',
    last_published_at: new Date().toISOString(),
    revision_id: 'resolved-revision',
    revision_workflow_id: 'workflow-a',
    project_blob_key: 'project-blob',
    dataset_blob_key: null,
    stats_graph_count: 1,
    stats_total_node_count: 2,
    stats_web_app_count: 1,
    revision_created_at: new Date().toISOString(),
    ui_graph_id: 'ui-graph-a',
    allowed_emails: ['user@example.com'],
  };
}

function createExecutionLookupPool() {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const row = createExecutionLookupRow();

  const pool = {
    async query(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      return { rows: [row] };
    },
  } as unknown as Pool;

  return { pool, queries };
}

test('managed folder move SQL escapes wildcard characters in prefix LIKE patterns', () => {
  assert.ok(
    MANAGED_WORKFLOW_SCHEMA_SQL.includes('DROP FUNCTION IF EXISTS move_managed_workflow_folder(TEXT, TEXT, TEXT, TEXT);'),
  );
  assert.ok(
    MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE FUNCTION move_managed_workflow_folder('),
  );
  assert.equal(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE OR REPLACE FUNCTION move_managed_workflow_folder('), false);
  assert.ok(
    MANAGED_WORKFLOW_SCHEMA_SQL.includes(
      String.raw`source_prefix_pattern TEXT := replace(replace(replace(source_relative_path, '\', '\\'), '%', '\%'), '_', '\_') || '/%';`,
    ),
  );
  assert.ok(
    MANAGED_WORKFLOW_SCHEMA_SQL.includes(
      String.raw`temporary_prefix_pattern TEXT := replace(replace(replace(temporary_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '/%';`,
    ),
  );

  const sourceEscapeMatches = MANAGED_WORKFLOW_SCHEMA_SQL.match(/LIKE source_prefix_pattern ESCAPE '\\'/g) ?? [];
  const temporaryEscapeMatches = MANAGED_WORKFLOW_SCHEMA_SQL.match(/LIKE temporary_prefix_pattern ESCAPE '\\'/g) ?? [];

  assert.ok(sourceEscapeMatches.length >= 2, `Expected source prefix LIKE clauses to use ESCAPE, found ${sourceEscapeMatches.length}`);
  assert.ok(
    temporaryEscapeMatches.length >= 2,
    `Expected temporary prefix LIKE clauses to use ESCAPE, found ${temporaryEscapeMatches.length}`,
  );
});

test('managed schema keeps published version history physically tied to workflow revisions', () => {
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('published_version_id TEXT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE workflows ADD COLUMN IF NOT EXISTS published_version_id TEXT NULL;'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS workflow_published_versions'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('stats_graph_count INTEGER NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_graph_count INTEGER NULL;'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_total_node_count INTEGER NULL;'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE workflow_revisions ADD COLUMN IF NOT EXISTS stats_web_app_count INTEGER NULL;'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('is_starred BOOLEAN NOT NULL DEFAULT FALSE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE workflow_published_versions ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT FALSE;'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes("comment TEXT NOT NULL DEFAULT ''"));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes("ALTER TABLE workflow_published_versions ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';"));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('workflow_published_versions_workflow_id_published_at_idx'));
});

test('managed schema keeps web app publications tied to immutable workflow revisions', () => {
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS workflow_web_apps'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ui_graph_id TEXT NOT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('slug_lookup_name TEXT NOT NULL UNIQUE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes("allowed_emails TEXT[] NOT NULL DEFAULT '{}'"));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes("ALTER TABLE workflow_web_apps ADD COLUMN IF NOT EXISTS allowed_emails TEXT[] NOT NULL DEFAULT '{}';"));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('UNIQUE (workflow_id, ui_graph_id)'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('workflow_web_apps_workflow_id_idx'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('workflow_web_apps_revision_id_idx'));
});

test('managed schema persists resumable web app action runs separately from recordings', () => {
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS web_app_action_runs'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('UNIQUE (owner_scope, request_id)'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('lease_id TEXT NOT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('lease_expires_at TIMESTAMPTZ NOT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE INDEX IF NOT EXISTS web_app_action_runs_lease_idx'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS web_app_action_run_events'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('PRIMARY KEY (run_id, sequence)'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS web_app_action_cancel_commands'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('web_app_action_cancel_commands_pending_idx'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ON DELETE CASCADE'));
});

test('managed schema persists shared LLM Profile health with project-scoped administration', () => {
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS llm_profile_health'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('key TEXT PRIMARY KEY'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('project_id TEXT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('entry_json JSONB NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ALTER TABLE llm_profile_health'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ADD COLUMN IF NOT EXISTS project_id TEXT NULL'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('llm_profile_health_project_id_idx'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('llm_profile_health_updated_at_idx'));
});

test('managed recording schema supports endpoint-scoped retention scans', () => {
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('workflow_recordings_endpoint_created_at_idx'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('ON workflow_recordings(workflow_id,'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('LOWER(BTRIM(endpoint_name_at_execution))'));
  assert.ok(MANAGED_WORKFLOW_SCHEMA_SQL.includes('created_at DESC, recording_id DESC'));
});

test('managed published execution lookup uses published endpoint rows and the published revision join', async () => {
  const { pool, queries } = createExecutionLookupPool();
  const managedQueries = createManagedWorkflowQueries(pool);

  const result = await managedQueries.resolveExecutionPointerFromDatabase(pool, 'published', 'public-live');

  assert.ok(result);
  assert.equal(result.pointer.relativePath, 'Main.rivet-project');
  assert.equal(result.pointer.revisionId, 'resolved-revision');
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.params, ['public-live']);

  const normalizedSql = queries[0]!.text.replace(/\s+/g, ' ').trim();
  assert.match(normalizedSql, /JOIN workflow_revisions r ON r\.revision_id = w\.published_revision_id/);
  assert.match(normalizedSql, /WHERE e\.lookup_name = \$1 AND e\.is_published = TRUE$/);
});

test('managed latest execution lookup uses draft endpoint rows but still requires published lineage', async () => {
  const { pool, queries } = createExecutionLookupPool();
  const managedQueries = createManagedWorkflowQueries(pool);

  const result = await managedQueries.resolveExecutionPointerFromDatabase(pool, 'latest', 'latest-only');

  assert.ok(result);
  assert.equal(result.pointer.relativePath, 'Main.rivet-project');
  assert.equal(result.pointer.revisionId, 'resolved-revision');
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.params, ['latest-only']);

  const normalizedSql = queries[0]!.text.replace(/\s+/g, ' ').trim();
  assert.match(normalizedSql, /JOIN workflow_revisions r ON r\.revision_id = w\.current_draft_revision_id/);
  assert.match(normalizedSql, /WHERE e\.lookup_name = \$1 AND e\.is_draft = TRUE AND w\.published_revision_id IS NOT NULL$/);
});

test('managed web app execution lookup uses the published web app slug and pinned revision', async () => {
  const { pool, queries } = createExecutionLookupPool();
  const managedQueries = createManagedWorkflowQueries(pool);

  const result = await managedQueries.resolveExecutionPointerFromDatabase(pool, 'web-app', 'app-slug');

  assert.ok(result);
  assert.equal(result.pointer.relativePath, 'Main.rivet-project');
  assert.equal(result.pointer.revisionId, 'resolved-revision');
  assert.equal(result.pointer.webAppUiGraphId, 'ui-graph-a');
  assert.deepEqual(result.pointer.webAppAllowedEmails, ['user@example.com']);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.params, ['app-slug']);

  const normalizedSql = queries[0]!.text.replace(/\s+/g, ' ').trim();
  assert.match(normalizedSql, /FROM workflow_web_apps app/);
  assert.match(normalizedSql, /JOIN workflow_revisions r ON r\.revision_id = app\.revision_id/);
  assert.match(normalizedSql, /app\.allowed_emails/);
  assert.match(normalizedSql, /WHERE app\.slug_lookup_name = \$1$/);
});

test('managed latest web app execution lookup uses the published web app slug and current draft revision', async () => {
  const { pool, queries } = createExecutionLookupPool();
  const managedQueries = createManagedWorkflowQueries(pool);

  const result = await managedQueries.resolveExecutionPointerFromDatabase(pool, 'latest-web-app', 'app-slug');

  assert.ok(result);
  assert.equal(result.pointer.relativePath, 'Main.rivet-project');
  assert.equal(result.pointer.revisionId, 'resolved-revision');
  assert.equal(result.pointer.webAppUiGraphId, 'ui-graph-a');
  assert.deepEqual(result.pointer.webAppAllowedEmails, ['user@example.com']);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.params, ['app-slug']);

  const normalizedSql = queries[0]!.text.replace(/\s+/g, ' ').trim();
  assert.match(normalizedSql, /FROM workflow_web_apps app/);
  assert.match(normalizedSql, /JOIN workflow_revisions r ON r\.revision_id = w\.current_draft_revision_id/);
  assert.match(normalizedSql, /app\.allowed_emails/);
  assert.match(normalizedSql, /WHERE app\.slug_lookup_name = \$1$/);
});
