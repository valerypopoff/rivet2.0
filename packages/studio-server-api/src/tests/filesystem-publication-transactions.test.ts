import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// These are temporary transaction artifacts, not repository source files.
const readArtifact = fs.readFile.bind(fs);

import { createBlankProjectFile, getWorkflowDatasetPath, getWorkflowProjectSettingsPath } from '../routes/workflows/fs-helpers.js';
import {
  FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR,
  FilesystemPublicationTransactionInterruption,
  recoverFilesystemPublicationTransactions,
  saveFilesystemPublicationTransaction,
  setFilesystemPublicationTransactionCheckpointForTests,
  type PublicationTransactionCheckpoint,
} from '../routes/workflows/filesystem-publication-transactions.js';

async function readOptional(filePath: string): Promise<string | null> {
  return readArtifact(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-publication-tx-'));
  const root = path.join(temp, 'workflows');
  const projectPath = path.join(root, 'Unicode', '深い', 'Graph.rivet-project');
  const settingsPath = getWorkflowProjectSettingsPath(projectPath);
  const oldId = randomUUID();
  const newId = randomUUID();
  const oldSnapshot = path.join(root, '.published', `${oldId}.rivet-project`);
  const newSnapshot = path.join(root, '.published', `${newId}.rivet-project`);
  const newMetadata = path.join(root, '.published', `${newId}.json`);
  const oldProject = createBlankProjectFile('Old');
  const newProject = createBlankProjectFile('New');
  const oldSettings = `${JSON.stringify({ endpointName: 'old', publishedSnapshotId: oldId })}\n`;
  const newSettings = `${JSON.stringify({ endpointName: 'new', publishedSnapshotId: newId })}\n`;
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.mkdir(path.dirname(oldSnapshot), { recursive: true });
  await fs.writeFile(projectPath, oldProject);
  await fs.writeFile(settingsPath, oldSettings);
  await fs.writeFile(oldSnapshot, oldProject);
  const changes = [
    { path: newSnapshot, contents: newProject },
    { path: newMetadata, contents: `${JSON.stringify({ version: 1, id: newId })}\n` },
    { path: settingsPath, contents: newSettings },
  ];
  const cleanupPaths = [oldSnapshot];
  return { temp, root, projectPath, settingsPath, oldSnapshot, newSnapshot, newMetadata, oldProject, newProject, oldSettings, newSettings, changes, cleanupPaths };
}

async function assertGeneration(value: Awaited<ReturnType<typeof fixture>>, generation: 'old' | 'new') {
  assert.equal(await readArtifact(value.projectPath, 'utf8'), value.oldProject);
  assert.equal(await readOptional(value.settingsPath), generation === 'old' ? value.oldSettings : value.newSettings);
  assert.equal(await readOptional(value.oldSnapshot), generation === 'old' ? value.oldProject : null);
  assert.equal(await readOptional(value.newSnapshot), generation === 'new' ? value.newProject : null);
  assert.equal(await readOptional(value.newMetadata) == null, generation === 'old');
}

test('publication rejects parseable but invalid settings before committing', async () => {
  const value = await fixture();
  try {
    for (const invalidSettings of [
      { endpointName: 'new', endpointAccess: 'unknown' },
      { endpointName: 'new', publishedWebApps: [{ uiGraphId: 'app' }] },
    ]) {
      await assert.rejects(saveFilesystemPublicationTransaction({
        root: value.root,
        projectPath: value.projectPath,
        changes: [{ path: value.settingsPath, contents: `${JSON.stringify(invalidSettings)}\n` }],
      }), /Invalid/);
      await assertGeneration(value, 'old');
      assert.deepEqual(await fs.readdir(path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR)), []);
    }
  } finally {
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

for (const checkpoint of ['staged', 'journal-staged', 'prepared', 'backed-up', 'promoted', 'validated', 'marker-staged', 'committed', 'cleanup'] as PublicationTransactionCheckpoint[]) {
  test(`publication crash at ${checkpoint} recovers the complete generation`, async () => {
    const value = await fixture();
    try {
      setFilesystemPublicationTransactionCheckpointForTests((reached) => {
        if (reached === checkpoint) throw new FilesystemPublicationTransactionInterruption(reached);
      });
      await assert.rejects(saveFilesystemPublicationTransaction({
        root: value.root,
        projectPath: value.projectPath,
        changes: value.changes,
        cleanupPaths: value.cleanupPaths,
      }), FilesystemPublicationTransactionInterruption);
      setFilesystemPublicationTransactionCheckpointForTests(null);
      assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
      await assertGeneration(value, checkpoint === 'committed' || checkpoint === 'cleanup' ? 'new' : 'old');
    } finally {
      setFilesystemPublicationTransactionCheckpointForTests(null);
      await fs.rm(value.temp, { recursive: true, force: true });
    }
  });
}

for (const [checkpoint, stagedName] of [
  ['journal-staged', 'journal.pending'],
  ['marker-staged', 'committed.pending'],
] as const) {
  test(`a partial ${stagedName} is discarded without mistaking it for a durable decision`, async () => {
    const value = await fixture();
    try {
      setFilesystemPublicationTransactionCheckpointForTests((reached) => {
        if (reached === checkpoint) throw new FilesystemPublicationTransactionInterruption(reached);
      });
      await assert.rejects(saveFilesystemPublicationTransaction({
        root: value.root, projectPath: value.projectPath, changes: value.changes,
      }), FilesystemPublicationTransactionInterruption);
      setFilesystemPublicationTransactionCheckpointForTests(null);
      const transactionRoot = path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
      const [id] = await fs.readdir(transactionRoot);
      assert.ok(id);
      await fs.writeFile(path.join(transactionRoot, id, stagedName), '{partial');
      assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
      await assertGeneration(value, 'old');
    } finally {
      setFilesystemPublicationTransactionCheckpointForTests(null);
      await fs.rm(value.temp, { recursive: true, force: true });
    }
  });
}

for (const phase of ['staged', 'backed-up', 'promoted'] as const) {
  for (const occurrence of [2, 3]) {
    test(`publication crash at ${phase} artifact ${occurrence} restores the old generation`, async () => {
      const value = await fixture();
      let seen = 0;
      try {
        setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
          if (checkpoint === phase && ++seen === occurrence) {
            throw new FilesystemPublicationTransactionInterruption(checkpoint);
          }
        });
        await assert.rejects(saveFilesystemPublicationTransaction({
          root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths,
        }), FilesystemPublicationTransactionInterruption);
        setFilesystemPublicationTransactionCheckpointForTests(null);
        await recoverFilesystemPublicationTransactions(value.root);
        await assertGeneration(value, 'old');
      } finally {
        setFilesystemPublicationTransactionCheckpointForTests(null);
        await fs.rm(value.temp, { recursive: true, force: true });
      }
    });
  }
}

test('ordinary promotion failure rolls back immediately', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw new Error('disk failure');
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths,
    }), /disk failure/);
    await assertGeneration(value, 'old');
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('publication preserves dataset sidecar bytes without UTF-8 decoding', async () => {
  const value = await fixture();
  try {
    const dataset = Buffer.from([0, 255, 254, 13, 10]);
    await fs.writeFile(getWorkflowDatasetPath(value.projectPath), dataset);
    await saveFilesystemPublicationTransaction({
      root: value.root,
      projectPath: value.projectPath,
      changes: [
        { path: value.newSnapshot, contents: value.oldProject },
        { path: getWorkflowDatasetPath(value.newSnapshot), contents: dataset },
      ],
    });
    assert.deepEqual(await readArtifact(getWorkflowDatasetPath(value.newSnapshot)), dataset);
  } finally {
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('batch web-app retirement can clean more than 64 snapshot artifacts', async () => {
  const value = await fixture();
  try {
    const cleanupPaths = [value.oldSnapshot, ...Array.from({ length: 65 }, () =>
      path.join(value.root, '.published', `${randomUUID()}.rivet-project`))];
    await saveFilesystemPublicationTransaction({
      root: value.root,
      projectPath: value.projectPath,
      changes: value.changes,
      cleanupPaths,
    });
    await assertGeneration(value, 'new');
  } finally {
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('a cleanup error cannot turn a committed publication into a failed response', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'cleanup') throw new Error('cleanup failed');
    });
    await saveFilesystemPublicationTransaction({ root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths });
    // The commit is visible even if retirement of the old snapshot is deferred.
    assert.equal(await readOptional(value.settingsPath), value.newSettings);
    assert.equal(await readOptional(value.newSnapshot), value.newProject);
    assert.equal(await readOptional(value.oldSnapshot), value.oldProject);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
    await assertGeneration(value, 'new');
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('committed cleanup preserves a backup whose checksum no longer matches the journal', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemPublicationTransactionInterruption(checkpoint);
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths,
    }), FilesystemPublicationTransactionInterruption);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    const transactionRoot = path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    assert.ok(id);
    const backupPath = path.join(transactionRoot, id, '2.old');
    await fs.writeFile(backupPath, 'changed backup');
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), true);
    assert.equal(await readOptional(backupPath), 'changed backup');
    assert.equal(await readOptional(value.settingsPath), value.newSettings);

    await fs.writeFile(backupPath, value.oldSettings);
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
    await assertGeneration(value, 'new');
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('unexpected transaction residue is detected before committed backups are removed', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemPublicationTransactionInterruption(checkpoint);
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root, projectPath: value.projectPath, changes: value.changes,
    }), FilesystemPublicationTransactionInterruption);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    const transactionRoot = path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    assert.ok(id);
    const transactionPath = path.join(transactionRoot, id);
    await fs.writeFile(path.join(transactionPath, 'unexpected'), 'evidence');
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), true);
    assert.equal(await readOptional(path.join(transactionPath, '2.old')), value.oldSettings);
    await fs.unlink(path.join(transactionPath, 'unexpected'));
    assert.equal(await recoverFilesystemPublicationTransactions(value.root), false);
    assert.equal(await readOptional(value.settingsPath), value.newSettings);
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('corrupt prepared journal fails closed and preserves evidence', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'prepared') throw new FilesystemPublicationTransactionInterruption(checkpoint);
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths,
    }), FilesystemPublicationTransactionInterruption);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    const transactionRoot = path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    assert.ok(id);
    await fs.writeFile(path.join(transactionRoot, id, 'journal.json'), '{corrupt');
    await assert.rejects(recoverFilesystemPublicationTransactions(value.root), /recovery failed/);
    assert.ok(await fs.stat(path.join(transactionRoot, id, 'journal.json')));
    await assertGeneration(value, 'old');
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('recovery refuses a transaction entry that is not a directory', async () => {
  const value = await fixture();
  try {
    const transactionRoot = path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR);
    await fs.mkdir(transactionRoot);
    const entry = path.join(transactionRoot, randomUUID());
    await fs.writeFile(entry, 'unexpected transaction evidence');
    await assert.rejects(recoverFilesystemPublicationTransactions(value.root), /not a same-filesystem directory/);
    assert.equal(await readArtifact(entry, 'utf8'), 'unexpected transaction evidence');
    await assertGeneration(value, 'old');
  } finally {
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('recovery refuses to overwrite an unrecognized canonical publication file', async () => {
  const value = await fixture();
  try {
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw new FilesystemPublicationTransactionInterruption(checkpoint);
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root, projectPath: value.projectPath, changes: value.changes, cleanupPaths: value.cleanupPaths,
    }), FilesystemPublicationTransactionInterruption);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.writeFile(value.newSnapshot, 'unrecognized bytes');
    await assert.rejects(recoverFilesystemPublicationTransactions(value.root), /recovery failed/);
    const entries = await fs.readdir(path.join(value.root, FILESYSTEM_PUBLICATION_TRANSACTIONS_DIR));
    assert.equal(entries.length, 1);
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});

test('restore-style project and dataset changes roll back together with publication settings', async () => {
  const value = await fixture();
  const datasetPath = getWorkflowDatasetPath(value.projectPath);
  try {
    await fs.writeFile(datasetPath, 'old-data');
    setFilesystemPublicationTransactionCheckpointForTests((checkpoint) => {
      if (checkpoint === 'validated') throw new FilesystemPublicationTransactionInterruption(checkpoint);
    });
    await assert.rejects(saveFilesystemPublicationTransaction({
      root: value.root,
      projectPath: value.projectPath,
      changes: [
        ...value.changes,
        { path: value.projectPath, contents: value.newProject },
        { path: datasetPath, contents: null },
      ],
      cleanupPaths: value.cleanupPaths,
    }), FilesystemPublicationTransactionInterruption);
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await recoverFilesystemPublicationTransactions(value.root);
    await assertGeneration(value, 'old');
    assert.equal(await readArtifact(datasetPath, 'utf8'), 'old-data');
  } finally {
    setFilesystemPublicationTransactionCheckpointForTests(null);
    await fs.rm(value.temp, { recursive: true, force: true });
  }
});
