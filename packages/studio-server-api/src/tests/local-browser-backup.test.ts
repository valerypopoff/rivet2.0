import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  browserBackupDirectory,
  createBrowserBackupArchive,
  hashBackupArchive,
  invalidateBrowserBackup,
  readBrowserBackup,
  restoreBrowserBackupArchive,
  saveBrowserBackup,
  type BrowserBackup,
} from '../local-metadata/browser-backup.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import type { LocalMetadataSourceRoots } from '../local-metadata/source-identity.js';
import { publishEmptyRuntimeRelease } from '@valerypopoff/rivet-studio-server-bootstrap/runtime-release-cache';
import { readSourceRuntimeSelection } from '../scripts/migrate-runtime-libraries.js';

// test-style: fixture-read: verifies generated backups and restored fixtures only.
async function statusFixture(run: (control: string, state: BrowserBackup) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-browser-backup-'));
  const control = path.join(root, 'control');
  try {
    await fs.mkdir(control);
    await run(control, {
      id: randomUUID(),
      revision: 1,
      pausedAt: 'paused-fixture',
      phase: 'creating',
      archiveHash: null,
      bytes: 0,
      createdAt: new Date().toISOString(),
      sourceFingerprint: 'a'.repeat(64),
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function fixture(
  run: (source: LocalMetadataSourceRoots, control: string, state: BrowserBackup) => Promise<void>,
) {
  await statusFixture(async (control, state) => {
    const root = path.dirname(control);
    const source: LocalMetadataSourceRoots = {
      workflows: path.join(root, 'workflows'),
      recordings: path.join(root, 'recordings'),
      appData: path.join(root, 'appData'),
      runtimeLibraries: path.join(root, 'runtimeLibraries'),
    };
    for (const directory of Object.values(source)) await fs.mkdir(directory);
    await fs.mkdir(path.join(source.workflows, 'empty'));
    await fs.writeFile(path.join(source.workflows, 'a.rivet-project'), 'project fixture');
    await fs.mkdir(path.join(source.appData, 'settings'));
    await fs.writeFile(path.join(source.appData, 'settings', 'secret.json'), '{"value":"fixture-secret"}');
    await fs.writeFile(path.join(source.appData, 'evaluation-runs.sqlite-wal'), 'wal fixture');
    await fs.writeFile(path.join(source.recordings, 'recording.gz'), Buffer.alloc(2 * 1048576, 42));
    await fs.writeFile(path.join(source.runtimeLibraries, 'index.js'), 'module.exports = 42');
    if (process.platform !== 'win32') {
      await fs.chmod(path.join(source.runtimeLibraries, 'index.js'), 0o755);
      await fs.chmod(path.join(source.workflows, 'empty'), 0o1777);
      await fs.symlink('index.js', path.join(source.runtimeLibraries, 'entry.js'));
    }
    state.sourceFingerprint = await fingerprintVmMigrationSource(source);
    await run(source, control, state);
  });
}

test('browser backup restores the downloadable archive, preserves source bytes and leaves only the verified archive', async () => {
  await fixture(async (source, control, state) => {
    const ready = await createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} });
    assert.equal(ready.phase, 'ready');
    assert.equal(await fingerprintVmMigrationSource(source), state.sourceFingerprint);
    const directory = browserBackupDirectory(control, state.id);
    assert.deepEqual(await fs.readdir(directory), ['backup.tar.gz']);
    assert.equal(await hashBackupArchive(path.join(directory, 'backup.tar.gz')), ready.archiveHash);
    await saveBrowserBackup(control, ready);
    assert.deepEqual(await readBrowserBackup(control), ready);
    const restored = path.join(control, 'test-restore');
    await fs.mkdir(restored);
    await restoreBrowserBackupArchive(path.join(directory, 'backup.tar.gz'), restored);
    assert.equal(
      await fs.readFile(path.join(restored, 'appData', 'settings', 'secret.json'), 'utf8'),
      '{"value":"fixture-secret"}',
    );
    assert.equal(
      await fs.readFile(path.join(restored, 'appData', 'evaluation-runs.sqlite-wal'), 'utf8'),
      'wal fixture',
    );
    const metadata = JSON.parse(await fs.readFile(path.join(restored, 'backup.json'), 'utf8'));
    assert.equal(metadata.encryptionKeyIncluded, false);
    assert.equal(metadata.sourceFingerprint, state.sourceFingerprint);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(restored, 'workflows', 'empty'))).mode & 0o1777, 0o1777);
      assert.equal((await fs.stat(path.join(restored, 'runtimeLibraries', 'index.js'))).mode & 0o777, 0o755);
      assert.equal(await fs.readlink(path.join(restored, 'runtimeLibraries', 'entry.js')), 'index.js');
    }
    await assert.rejects(createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} }));
  });
});

test('full backups preserve retained cache history as well as the selected empty release', async () => {
  await fixture(async (source, control, state) => {
    const old = await publishEmptyRuntimeRelease(source.runtimeLibraries, {
      packages: {},
      updatedAt: '',
      activeReleaseId: 'old',
    });
    await fs.writeFile(path.join(old.snapshot.directory, 'history.txt'), 'retained source bytes');
    const active = await publishEmptyRuntimeRelease(source.runtimeLibraries, {
      packages: {},
      updatedAt: '',
      activeReleaseId: 'active',
    });
    state.sourceFingerprint = await fingerprintVmMigrationSource(source);
    await createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} });
    const restored = path.join(control, 'with-history');
    await fs.mkdir(restored);
    await restoreBrowserBackupArchive(path.join(browserBackupDirectory(control, state.id), 'backup.tar.gz'), restored);
    const libraries = path.join(restored, 'runtimeLibraries');
    assert.equal(
      await fs.readFile(path.join(libraries, path.basename(old.snapshot.directory), 'history.txt'), 'utf8'),
      'retained source bytes',
    );
    assert.equal((await readSourceRuntimeSelection(libraries)).manifest.activeReleaseId, 'active');
    assert.equal((await fs.readdir(libraries)).filter((name) => name.startsWith('cache-')).length, 2);
    assert.notEqual(old.snapshot.directory, active.snapshot.directory);
    await fs.writeFile(path.join(old.snapshot.directory, 'history.txt'), 'changed history');
    assert.notEqual(await fingerprintVmMigrationSource(source), state.sourceFingerprint);
  });
});

test(
  'Windows backup status replacement tolerates an overlapping reader',
  { skip: process.platform !== 'win32' },
  async (t) => {
    await statusFixture(async (control, state) => {
      await saveBrowserBackup(control, state);
      const file = path.join(control, 'browser-backup.json');
      let reader: Awaited<ReturnType<typeof fs.open>> | undefined = await fs.open(file, 'r');
      const rename = fs.rename;
      const sources: string[] = [];
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
        if (String(args[1]) !== file) return rename(...args);
        sources.push(String(args[0]));
        try {
          return await rename(...args);
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'EPERM');
          await reader?.close();
          reader = undefined;
          throw error;
        }
      });
      try {
        const next = { ...state, phase: 'failed' as const };
        await saveBrowserBackup(control, next);
        assert.deepEqual(await readBrowserBackup(control), next);
        assert.equal(sources.length, 2);
        assert.equal(new Set(sources).size, 1);
        assert.deepEqual(await fs.readdir(control), ['browser-backup.json']);
      } finally {
        await reader?.close();
      }
    });
  },
);

test('failed backup status publication preserves prior evidence and removes its temporary file', async (t) => {
  await statusFixture(async (control, state) => {
    await saveBrowserBackup(control, state);
    const file = path.join(control, 'browser-backup.json');
    const rename = fs.rename;
    let attempts = 0;
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]) !== file) return rename(...args);
      attempts++;
      throw Object.assign(new Error('Fixture backup status write failed'), { code: 'EIO' });
    });
    await assert.rejects(saveBrowserBackup(control, { ...state, phase: 'failed' }), { code: 'EIO' });
    assert.equal(attempts, 1);
    assert.deepEqual(await readBrowserBackup(control), state);
    assert.deepEqual(await fs.readdir(control), ['browser-backup.json']);
  });
});

test('backup refuses absent maintenance, changed source and overlapping authorities without certifying anything', async () => {
  await fixture(async (source, control, state) => {
    await assert.rejects(
      createBrowserBackupArchive({
        source,
        control,
        state,
        assertFrozen: async () => {
          throw new Error('not paused');
        },
      }),
      /not paused/,
    );
    assert.equal(await readBrowserBackup(control), null);
    await assert.rejects(
      createBrowserBackupArchive({
        source: { ...source, recordings: source.workflows },
        control,
        state,
        assertFrozen: async () => {},
      }),
      /overlap/,
    );
    await fs.writeFile(path.join(source.workflows, 'a.rivet-project'), 'new edit');
    await assert.rejects(
      createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} }),
      /Frozen source changed/,
    );
  });
});

test('backup rejects source drift during copying and never publishes ready state', async () => {
  await fixture(async (source, control, state) => {
    let checks = 0;
    await assert.rejects(
      createBrowserBackupArchive({
        source,
        control,
        state,
        assertFrozen: async () => {
          if (++checks === 3)
            await fs.writeFile(path.join(source.workflows, 'a.rivet-project'), 'concurrent host edit');
        },
      }),
      /differs|changed/,
    );
    assert.equal(await readBrowserBackup(control), null);
  });
});

test('backup status rejects corrupt metadata, inconsistent readiness and archive links', async () => {
  await statusFixture(async (control, state) => {
    await fs.writeFile(path.join(control, 'browser-backup.json'), '{broken');
    await assert.rejects(readBrowserBackup(control));
    await assert.rejects(hashBackupArchive(path.join(control, 'browser-backup.json', 'bad')));
    assert.throws(() => browserBackupDirectory(control, '../outside'));
    await fs.writeFile(path.join(control, 'browser-backup.json'), JSON.stringify({ ...state, phase: 'ready' }));
    await assert.rejects(readBrowserBackup(control), /archive evidence/);
    await assert.rejects(saveBrowserBackup(control, { ...state, archiveHash: 'a'.repeat(64) }), /archive evidence/);
  });
});

test('invalidating obsolete backup evidence preserves corrupt status and archives without requiring a read', async () => {
  await statusFixture(async (control, state) => {
    await invalidateBrowserBackup(control);
    const directory = browserBackupDirectory(control, state.id);
    await fs.mkdir(directory, { recursive: true });
    const archive = Buffer.from('retained old archive fixture');
    await fs.writeFile(path.join(directory, 'backup.tar.gz'), archive);
    const contents = '{obsolete corrupt private metadata';
    await fs.writeFile(path.join(control, 'browser-backup.json'), contents);
    await assert.rejects(readBrowserBackup(control));
    await invalidateBrowserBackup(control);
    assert.equal(await readBrowserBackup(control), null);
    const retained = (await fs.readdir(control)).filter((name) => name.startsWith('browser-backup-invalidated-'));
    assert.equal(retained.length, 1);
    assert.equal(await fs.readFile(path.join(control, retained[0]!), 'utf8'), contents);
    assert.deepEqual(await fs.readFile(path.join(directory, 'backup.tar.gz')), archive);
    await invalidateBrowserBackup(control);
    await saveBrowserBackup(control, state);
    assert.deepEqual(
      await readBrowserBackup(control),
      state,
      'new verified backup workflow can publish a fresh status',
    );
    await fs.rm(path.join(control, 'browser-backup.json'));
    await fs.mkdir(path.join(control, 'browser-backup.json'));
    await assert.rejects(invalidateBrowserBackup(control), /Invalid backup status entry/);
  });
});

test('backup refuses insufficient disk capacity without publishing an archive', async (t) => {
  await fixture(async (source, control, state) => {
    t.mock.method(fs, 'statfs', async () => ({ bavail: 0, bsize: 4096 }));
    await assert.rejects(
      createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} }),
      /Insufficient backup disk space/,
    );
    assert.deepEqual(await fs.readdir(browserBackupDirectory(control, state.id)), []);
    assert.equal(await readBrowserBackup(control), null);
  });
});

test('backup preserves read-only directories without failing scratch cleanup under a non-root user', async () => {
  await fixture(async (source, control, state) => {
    const directory = path.join(source.runtimeLibraries, 'read-only');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'index.js'), 'read-only fixture');
    if (process.platform !== 'win32') await fs.symlink('../index.js', path.join(directory, 'parent.js'));
    await fs.chmod(directory, 0o555);
    try {
      state.sourceFingerprint = await fingerprintVmMigrationSource(source);
      const ready = await createBrowserBackupArchive({ source, control, state, assertFrozen: async () => {} });
      assert.equal(ready.phase, 'ready');
      assert.deepEqual(await fs.readdir(browserBackupDirectory(control, state.id)), ['backup.tar.gz']);
      assert.equal(await fingerprintVmMigrationSource(source), state.sourceFingerprint);
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o555);
        assert.equal((await fs.stat(path.join(source.runtimeLibraries, 'index.js'))).mode & 0o777, 0o755);
        assert.equal(await fs.readlink(path.join(directory, 'parent.js')), '../index.js');
      }
    } finally {
      // Only this test-owned source is made writable for fixture disposal.
      await fs.chmod(directory, 0o755);
      // A failing implementation may leave read-only copied scratch behind.
      for (const scratch of ['staging', 'restored'])
        await fs
          .chmod(path.join(browserBackupDirectory(control, state.id), scratch, 'runtimeLibraries', 'read-only'), 0o755)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
    }
  });
});
