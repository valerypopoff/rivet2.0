import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { stageLocalMetadataCandidate } from '../local-metadata/stage-local-metadata-candidate.js';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { localMetadataSourceIdentity } from '../local-metadata/source-identity.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { createBlankProjectFile } from '../routes/workflows/fs-helpers.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';

// test-style: fixture-read: reads only generated temporary project bytes to verify non-destructive copying.

test('a late candidate-copy failure preserves the old files and leaves legacy selected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-failed-copy-'));
  const source = {
    workflows: path.join(root, 'source', 'workflows'),
    recordings: path.join(root, 'source', 'recordings'),
    appData: path.join(root, 'source', 'app-data'),
    runtimeLibraries: path.join(root, 'source', 'runtime-libraries'),
  };
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot: path.join(root, 'candidate', 'objects'),
  };
  const journal = new LocalMetadataTransitionJournal(path.join(root, 'transition.sqlite'));
  try {
    await journal.initialize({ create: true });
    for (const directory of Object.values(source)) await fs.mkdir(directory, { recursive: true });
    const original = createBlankProjectFile('Unchanged legacy project');
    const projectPath = path.join(source.workflows, 'original.rivet-project');
    await fs.writeFile(projectPath, original);
    await fs.mkdir(path.join(source.runtimeLibraries, 'current'), { recursive: true });
    await fs.writeFile(path.join(source.runtimeLibraries, 'current', 'package.json'), '{}');
    await fs.writeFile(
      path.join(source.runtimeLibraries, 'manifest.json'),
      JSON.stringify({
        packages: { example: { name: 'example', version: '1.0.0' } },
        updatedAt: '',
      }),
    );
    const before = await fingerprintVmMigrationSource(source);
    const selected = journal.read();
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      await assert.rejects(
        stageLocalMetadataCandidate({
          source,
          candidate,
          settingsEncryptionKey: 'test-key',
          assertFrozen: async () => {},
        }),
        /ENOENT/,
      );
    });
    assert.equal(
      (await fs.stat(candidate.catalogDatabasePath)).isFile(),
      true,
      'The failure occurs after project staging',
    );
    assert.equal(
      (await fs.stat(candidate.settingsDatabasePath)).isFile(),
      true,
      'Settings were also staged before the release failed',
    );
    assert.equal(await fingerprintVmMigrationSource(source), before);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original);
    assert.deepEqual(journal.read(), selected);
    assert.equal(journal.read().backend, 'legacy');
  } finally {
    journal.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('frozen local candidate copies and re-verifies projects, App Settings, and runtime libraries without activation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-candidate-'));
  const source = {
    workflows: path.join(root, 'source', 'workflows'),
    recordings: path.join(root, 'source', 'recordings'),
    appData: path.join(root, 'source', 'app-data'),
    runtimeLibraries: path.join(root, 'source', 'runtime-libraries'),
  };
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot: path.join(root, 'candidate', 'objects'),
  };
  try {
    await fs.mkdir(source.workflows, { recursive: true });
    await fs.mkdir(path.join(source.appData, 'settings'), { recursive: true });
    await fs.mkdir(path.join(source.runtimeLibraries, 'current', 'node_modules', 'example'), { recursive: true });
    await fs.writeFile(path.join(source.runtimeLibraries, 'current', 'package.json'), '{"name":"current"}');
    await fs.writeFile(
      path.join(source.runtimeLibraries, 'current', 'node_modules', 'example', 'index.js'),
      'module.exports = 1;',
    );
    try {
      await fs.symlink(
        'index.js',
        path.join(source.runtimeLibraries, 'current', 'node_modules', 'example', 'command'),
        'file',
      );
    } catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await fs.writeFile(
      path.join(source.runtimeLibraries, 'manifest.json'),
      JSON.stringify({
        packages: { example: { name: 'example', version: '1.0.0' } },
        updatedAt: '2026-01-01T00:00:00.000Z',
        activeReleaseId: 'local-release',
      }),
    );
    await fs.writeFile(path.join(source.workflows, 'story.rivet-project'), createBlankProjectFile('story'));
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const options = { source, candidate, settingsEncryptionKey: 'test-key', assertFrozen: async () => {} };
      const staged = await stageLocalMetadataCandidate(options);
      assert.equal(staged.reportVersion, 1);
      assert.equal(staged.activationReady, false, 'Candidate readback is not a complete activation certificate');
      assert.equal(staged.projects, 1);
      assert.equal(staged.recordings, 0);
      assert.equal(staged.runtimeLibraryPackages, 1);
      assert.equal(staged.sourceIdentity, localMetadataSourceIdentity(source));
      assert.ok(staged.appSettingsDomains > 0);
      assert.equal(
        (await stageLocalMetadataCandidate({ ...options, verifyOnly: true })).sourceFingerprint,
        staged.sourceFingerprint,
      );
      await fs.writeFile(path.join(source.workflows, 'story.rivet-project'), createBlankProjectFile('changed'));
      await assert.rejects(stageLocalMetadataCandidate({ ...options, verifyOnly: true }), /differs from source/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidate staging refuses to place metadata or artifacts inside source roots', async () => {
  const root = path.join(os.tmpdir(), 'rivet-local-candidate-paths');
  const source = {
    workflows: path.join(root, 'workflows'),
    recordings: path.join(root, 'recordings'),
    appData: path.join(root, 'app-data'),
    runtimeLibraries: path.join(root, 'runtime-libraries'),
  };
  await assert.rejects(
    stageLocalMetadataCandidate({
      source,
      candidate: {
        catalogDatabasePath: path.join(source.appData, 'catalog.sqlite'),
        settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
        artifactRoot: path.join(root, 'candidate', 'objects'),
      },
      settingsEncryptionKey: 'test-key',
      assertFrozen: async () => {},
    }),
    /outside every source root/,
  );
});

test('candidate staging rejects a symlinked artifact root before creating either database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-candidate-link-'));
  const source = {
    workflows: path.join(root, 'source', 'workflows'),
    recordings: path.join(root, 'source', 'recordings'),
    appData: path.join(root, 'source', 'app-data'),
    runtimeLibraries: path.join(root, 'source', 'runtime-libraries'),
  };
  const target = path.join(root, 'target');
  const artifactRoot = path.join(root, 'artifact-link');
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot,
  };
  try {
    await fs.mkdir(target);
    try {
      await fs.symlink(target, artifactRoot, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Windows symlink creation is unavailable on this host');
        return;
      }
      throw error;
    }
    await assert.rejects(
      stageLocalMetadataCandidate({
        source,
        candidate,
        settingsEncryptionKey: 'test-key',
        assertFrozen: async () => {},
      }),
      /artifact root must be a real directory/,
    );
    await assert.rejects(fs.stat(candidate.catalogDatabasePath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(candidate.settingsDatabasePath), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidate staging creates nothing when the initial maintenance check fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-candidate-fence-'));
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot: path.join(root, 'candidate', 'objects'),
  };
  try {
    await assert.rejects(
      stageLocalMetadataCandidate({
        source: {
          workflows: path.join(root, 'source', 'workflows'),
          recordings: path.join(root, 'source', 'recordings'),
          appData: path.join(root, 'source', 'app-data'),
          runtimeLibraries: path.join(root, 'source', 'runtime-libraries'),
        },
        candidate,
        settingsEncryptionKey: 'test-key',
        assertFrozen: async () => {
          throw new Error('maintenance is not active');
        },
      }),
      /maintenance is not active/,
    );
    await assert.rejects(fs.stat(path.dirname(candidate.artifactRoot)), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('candidate staging snapshots caller-owned paths before asynchronous validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-candidate-path-mutation-'));
  const source = {
    workflows: path.join(root, 'source', 'workflows'),
    recordings: path.join(root, 'source', 'recordings'),
    appData: path.join(root, 'source', 'app-data'),
    runtimeLibraries: path.join(root, 'source', 'runtime-libraries'),
  };
  const candidate = {
    catalogDatabasePath: path.join(root, 'candidate', 'catalog.sqlite'),
    settingsDatabasePath: path.join(root, 'candidate', 'settings.sqlite'),
    artifactRoot: path.join(root, 'candidate', 'objects'),
  };
  const original = { ...candidate };
  try {
    await fs.mkdir(source.workflows, { recursive: true });
    await fs.mkdir(path.join(source.appData, 'settings'), { recursive: true });
    await withEnvOverride('RIVET_EXTRA_ROOTS', root, async () => {
      const staging = stageLocalMetadataCandidate({
        source,
        candidate,
        settingsEncryptionKey: 'test-key',
        assertFrozen: async () => {},
      });
      candidate.artifactRoot = path.join(source.workflows, 'unsafe-target');
      candidate.catalogDatabasePath = path.join(source.workflows, 'unsafe.sqlite');
      source.workflows = path.join(root, 'missing-source');
      const result = await staging;
      assert.equal(result.projects, 0);
      assert.ok((await fs.stat(original.catalogDatabasePath)).isFile());
      assert.ok((await fs.stat(original.artifactRoot)).isDirectory());
      await assert.rejects(fs.stat(candidate.artifactRoot), { code: 'ENOENT' });
      await assert.rejects(fs.stat(candidate.catalogDatabasePath), { code: 'ENOENT' });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
