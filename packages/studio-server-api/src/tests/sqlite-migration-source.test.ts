// test-style: fixture-read: reads only generated migration fixture files to check read-only export.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import { localMetadataGenerationPaths } from '../local-metadata/serving-selection.js';
import { localMetadataSourceIdentity } from '../local-metadata/source-identity.js';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { SqliteMigrationSource } from '../scripts/sqlite-migration-source.js';
import { collectSourceAppSettings } from '../scripts/migrate-app-settings.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

test('native migration exports the live SQLite generation, compressed recordings and settings without legacy reads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-native-migration-'));
  const roots = {
    workflows: path.join(root, 'retained-workflows'),
    recordings: path.join(root, 'retained-recordings'),
    runtimeLibraries: path.join(root, 'retained-libraries'),
    appData: path.join(root, 'app-data'),
  };
  const controlRoot = path.join(root, 'control');
  const paths = localMetadataGenerationPaths(controlRoot, 'live-generation');
  const catalog = new LocalWorkflowCatalog({
    databasePath: paths.catalogDatabasePath,
    artifactRoot: paths.artifactRoot,
  });
  const backend = new SqliteWorkflowBackend({
    databasePath: paths.catalogDatabasePath,
    artifactRoot: paths.artifactRoot,
    virtualRoot: roots.workflows,
    withWrite: (operation) => operation(),
  });
  const settings = new SqliteAppSettingsBackend({ databasePath: paths.settingsDatabasePath });
  const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
  let source: SqliteMigrationSource | undefined;
  try {
    await fs.mkdir(roots.appData, { recursive: true });
    await fs.mkdir(paths.operationalRoot, { recursive: true });
    catalog.initialize();
    backend.initialize();
    await settings.initialize();
    const item = await backend.createWorkflowProjectItem('', 'Live project');
    const project = await catalog.readProject(item.relativePath);
    assert.ok(project);
    await withEnvOverride('RIVET_RECORDINGS_COMPRESS', 'gzip', async () => {
      await catalog.importRecording({
        recordingId: 'native-run',
        workflowId: project.workflowId,
        sourceProjectRelativePath: project.relativePath,
        sourceProjectName: project.name,
        createdAt: '2026-10-01T00:00:00.000Z',
        runKind: 'latest',
        status: 'succeeded',
        durationMs: 12,
        endpointName: '',
        errorMessage: null,
        recordingContents: 'recording payload '.repeat(1000),
        replayProjectContents: project.contents,
        replayDatasetContents: null,
      });
    });
    await catalog.importRuntimeLibraryState({ manifest: { packages: {}, updatedAt: '' }, archive: null });
    await settings.write({
      key: 'environment variable',
      expectedRevision: null,
      schemaVersion: 1,
      value: { version: 1, variables: [], updatedAt: null },
      sourceHash: null,
    });
    const proof = {
      id: 'live-generation',
      sourceIdentity: localMetadataSourceIdentity(roots),
      candidateIdentity: '1'.repeat(64),
      sourceFingerprint: '2'.repeat(64),
      candidateFingerprint: '3'.repeat(64),
      reportHash: '4'.repeat(64),
    };
    await journal.initialize({ create: true });
    const verified = journal.recordVerifiedCandidate(1, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    const validated = journal.recordRuntimeValidation(selected.revision, 'sqlite', proof.id, '5'.repeat(64));
    journal.resumeWrites(validated.revision, proof);
    await withEnvOverride('RIVET_MIGRATION_SOURCE_STOPPED', '1', async () => {
      await withEnvOverride('RIVET_MIGRATION_SOURCE_QUIESCED', '1', async () => {
        await assert.rejects(SqliteMigrationSource.open(controlRoot, roots), { code: 'ENOENT' });
        await SqliteMigrationSource.freeze(controlRoot, roots);
        await withEnvOverride('RIVET_MIGRATION_SOURCE_STOPPED', '0', async () => {
          await assert.rejects(SqliteMigrationSource.open(controlRoot, roots), /acknowledge SOURCE_STOPPED/);
        });
        source = await SqliteMigrationSource.open(controlRoot, roots);
        assert.equal((await source.projectHeaders())[0]?.workflowId, project.workflowId);
        for await (const exported of source.projects()) {
          assert.equal(exported.workflowId, project.workflowId);
          assert.equal(exported.contents, project.contents);
        }
        assert.equal(
          await source.workflows.readWorkflowRecordingArtifact('native-run', 'recording'),
          'recording payload '.repeat(1000),
        );
        assert.equal(source.catalog.listRecordingIds().length, 1);
        const rows = await collectSourceAppSettings(roots.appData, undefined, source.settings);
        assert.ok(rows.find((row) => row.key === 'environment variable')?.sourceHash);
        const before = await source.manifest();
        await settings.write({
          key: 'environment variable',
          expectedRevision: 1n,
          schemaVersion: 1,
          value: { version: 1, variables: [], updatedAt: '2026-10-02T00:00:00.000Z' },
          sourceHash: null,
        });
        assert.notEqual((await source.manifest()).settings, before.settings);
        await assert.rejects(
          SqliteMigrationSource.open(controlRoot, { ...roots, workflows: path.join(root, 'wrong') }),
          /roots differ/,
        );
        await fs.rm(path.join(roots.appData, 'vm-migration-maintenance.json'));
        await assert.rejects(source.assertFrozen(), { code: 'ENOENT' });
      });
    });
    await assert.rejects(fs.stat(roots.workflows), { code: 'ENOENT' });
    await assert.rejects(fs.stat(roots.recordings), { code: 'ENOENT' });
  } finally {
    await source?.dispose();
    journal.close();
    backend.close();
    catalog.close();
    await settings.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
