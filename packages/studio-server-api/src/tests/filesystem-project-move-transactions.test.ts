import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBlankProjectFile, getProjectSidecarPaths } from '../routes/workflows/fs-helpers.js';
import {
  FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR,
  FilesystemProjectMoveInterruption,
  moveProjectWithSidecars,
  recoverFilesystemProjectMoveTransactions,
  setFilesystemProjectMoveCheckpointForTests,
  type FilesystemProjectMoveCheckpoint,
} from '../routes/workflows/filesystem-project-move-transactions.js';
import {
  checkFilesystemProjectTransactionHealth,
  initializeFilesystemProjectTransactions,
  withFilesystemWorkflowStorageRead,
  withFilesystemWorkflowStorageWrite,
} from '../routes/workflows/filesystem-project-transactions.js';
import { createDefaultStoredWorkflowProjectSettings } from '../routes/workflows/publication.js';

const kinds = ['project', 'dataset', 'settings', 'stats'] as const;
type Kind = typeof kinds[number];

function artifactPath(projectPath: string, kind: Kind): string {
  return kind === 'project' ? projectPath : getProjectSidecarPaths(projectPath)[kind];
}

async function readArtifactBytes(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(filePath)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function createFixture(options: { dataset?: boolean; settings?: boolean; stats?: boolean } = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-move-'));
  const root = path.join(tempRoot, 'workflows');
  const source = path.join(root, '源', 'Nested', 'Published.rivet-project');
  const target = path.join(root, 'Destination', 'Published.rivet-project');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = new Map<Kind, Buffer>();
  bytes.set('project', Buffer.from(createBlankProjectFile('Published')));
  if (options.dataset !== false) bytes.set('dataset', Buffer.from('legacy binary dataset\n'));
  if (options.settings !== false) bytes.set('settings', Buffer.from(JSON.stringify({
    ...createDefaultStoredWorkflowProjectSettings(),
    endpointName: 'published-endpoint',
    publishedEndpointName: 'published-endpoint',
    publishedSnapshotId: 'snapshot-id',
    publicationVersion: '7',
  })));
  if (options.stats !== false) bytes.set('stats', Buffer.from('{"generated":true}'));
  for (const [kind, contents] of bytes) await fs.writeFile(artifactPath(source, kind), contents);
  await initializeFilesystemProjectTransactions(root);
  return { tempRoot, root, source, target, bytes };
}

async function assertGeneration(fixture: Awaited<ReturnType<typeof createFixture>>, generation: 'old' | 'next'): Promise<void> {
  for (const kind of kinds) {
    const oldPath = artifactPath(fixture.source, kind);
    const targetPath = artifactPath(fixture.target, kind);
    const contents = fixture.bytes.get(kind);
    if (generation === 'old' && contents) assert.deepEqual(await readArtifactBytes(oldPath), contents);
    else await assert.rejects(readArtifactBytes(oldPath), { code: 'ENOENT' });
    if (generation === 'next' && contents && kind !== 'stats') assert.deepEqual(await readArtifactBytes(targetPath), contents);
    else await assert.rejects(readArtifactBytes(targetPath), { code: 'ENOENT' });
  }
}

for (const [checkpoint, occurrence, committed] of [
  ['staged', 1, false], ['staged', 4, false], ['journal-staged', 1, false], ['prepared', 1, false],
  ['backed-up', 1, false], ['backed-up', 4, false], ['promoted', 1, false], ['promoted', 4, false],
  ['validated', 1, false], ['marker-staged', 1, false], ['committed', 1, true], ['cleanup', 1, true],
] as const) {
  test(`move recovery at ${checkpoint} #${occurrence} preserves ${committed ? 'new' : 'old'} generation`, async () => {
    const fixture = await createFixture();
    let seen = 0;
    try {
      setFilesystemProjectMoveCheckpointForTests((current) => {
        if (current === checkpoint && ++seen === occurrence) throw new FilesystemProjectMoveInterruption(current);
      });
      await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
      setFilesystemProjectMoveCheckpointForTests(null);
      await recoverFilesystemProjectMoveTransactions(fixture.root);
      await assertGeneration(fixture, committed ? 'next' : 'old');
      assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
    } finally {
      setFilesystemProjectMoveCheckpointForTests(null);
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
}

test('move preserves optional sidecars and never creates a stats cache at the new path', async () => {
  const fixture = await createFixture({ dataset: false, settings: false });
  try {
    await moveProjectWithSidecars(fixture.root, fixture.source, fixture.target);
    await assertGeneration(fixture, 'next');
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a destination orphan sidecar refuses the move without changing either project', async () => {
  const fixture = await createFixture();
  try {
    const orphan = artifactPath(fixture.target, 'settings');
    await fs.writeFile(orphan, '{"unrelated":true}');
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), /Settings file already exists/);
    await fs.unlink(orphan);
    await assertGeneration(fixture, 'old');
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('corrupt publication settings refuse the move before creating a journal', async () => {
  const fixture = await createFixture();
  try {
    const settingsPath = artifactPath(fixture.source, 'settings');
    await fs.writeFile(settingsPath, '{broken');
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), SyntaxError);
    assert.equal((await readArtifactBytes(settingsPath)).toString('utf8'), '{broken');
    await assert.rejects(fs.stat(fixture.target), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('an ordinary pre-commit error rolls the move back immediately', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), /disk full/);
    await assertGeneration(fixture, 'old');
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a permission error during promotion restores the complete old generation', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'backed-up') throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), { code: 'EACCES' });
    await assertGeneration(fixture, 'old');
    assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('coordinated reads and writes cannot observe a partially moved project', async () => {
  const fixture = await createFixture();
  const previousRoot = process.env.RIVET_WORKFLOWS_ROOT;
  process.env.RIVET_WORKFLOWS_ROOT = fixture.root;
  let resumeMove!: () => void;
  let signalPaused!: () => void;
  const paused = new Promise<void>((resolve) => { signalPaused = resolve; });
  const resume = new Promise<void>((resolve) => { resumeMove = resolve; });
  let readStarted = false;
  let writeStarted = false;
  try {
    setFilesystemProjectMoveCheckpointForTests(async (checkpoint) => {
      if (checkpoint !== 'backed-up') return;
      signalPaused();
      await resume;
    });
    const moving = withFilesystemWorkflowStorageWrite(() => moveProjectWithSidecars(fixture.root, fixture.source, fixture.target));
    await paused;
    const reading = withFilesystemWorkflowStorageRead(async () => {
      readStarted = true;
      await assertGeneration(fixture, 'next');
    });
    const writing = withFilesystemWorkflowStorageWrite(async () => {
      writeStarted = true;
      await assertGeneration(fixture, 'next');
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(readStarted, false);
    assert.equal(writeStarted, false);
    resumeMove();
    await Promise.all([moving, reading, writing]);
    assert.equal(readStarted, true);
    assert.equal(writeStarted, true);
  } finally {
    resumeMove?.();
    if (previousRoot === undefined) delete process.env.RIVET_WORKFLOWS_ROOT;
    else process.env.RIVET_WORKFLOWS_ROOT = previousRoot;
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('startup recovery rolls back a prepared move before serving requests', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    await initializeFilesystemProjectTransactions(fixture.root);
    checkFilesystemProjectTransactionHealth(fixture.root);
    await assertGeneration(fixture, 'old');
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('startup recovery retains a committed move and cleans its journal', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    await initializeFilesystemProjectTransactions(fixture.root);
    checkFilesystemProjectTransactionHealth(fixture.root);
    await assertGeneration(fixture, 'next');
    assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a modified staged artifact is rejected before canonical paths change', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests(async (checkpoint) => {
      if (checkpoint !== 'prepared') return;
      const [id] = await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR));
      await fs.appendFile(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR, id!, 'project.new'), '\nchanged');
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), /checksum mismatch/);
    await assertGeneration(fixture, 'old');
    assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a post-commit cleanup error still reports a successful move', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'cleanup') throw new Error('cleanup failed');
    });
    await moveProjectWithSidecars(fixture.root, fixture.source, fixture.target);
    await assertGeneration(fixture, 'next');
    setFilesystemProjectMoveCheckpointForTests(null);
    await recoverFilesystemProjectMoveTransactions(fixture.root);
    assert.deepEqual(await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR)), []);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('failure to confirm marker durability never reports a successful move', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'marker-renamed') throw new Error('directory sync failed');
    });
    await assert.rejects(
      moveProjectWithSidecars(fixture.root, fixture.source, fixture.target),
      /uncertain commit marker/,
    );
    setFilesystemProjectMoveCheckpointForTests(null);
    await recoverFilesystemProjectMoveTransactions(fixture.root);
    await assertGeneration(fixture, 'next');
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('an uncertain move marker holds filesystem API reads closed until restart recovery', async () => {
  const fixture = await createFixture();
  const previousRoot = process.env.RIVET_WORKFLOWS_ROOT;
  process.env.RIVET_WORKFLOWS_ROOT = fixture.root;
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'marker-renamed') throw new Error('directory sync failed');
    });
    await assert.rejects(
      withFilesystemWorkflowStorageWrite(() => moveProjectWithSidecars(fixture.root, fixture.source, fixture.target)),
      /recovery failed closed/,
    );
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    setFilesystemProjectMoveCheckpointForTests(null);
    await initializeFilesystemProjectTransactions(fixture.root);
    checkFilesystemProjectTransactionHealth(fixture.root);
    await assertGeneration(fixture, 'next');
  } finally {
    if (previousRoot === undefined) delete process.env.RIVET_WORKFLOWS_ROOT;
    else process.env.RIVET_WORKFLOWS_ROOT = previousRoot;
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('tampered canonical bytes fail recovery closed and preserve evidence', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.appendFile(fixture.target, '\nchanged');
    await assert.rejects(initializeFilesystemProjectTransactions(fixture.root), /checksum mismatch/);
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    assert.equal((await fs.readdir(path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR))).length, 1);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('tampered move backup fails recovery closed without deleting the promoted project', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    const transactionRoot = path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    const backup = path.join(transactionRoot, id!, 'project.old');
    await fs.appendFile(backup, '\ntampered');
    await assert.rejects(initializeFilesystemProjectTransactions(fixture.root), /Invalid move backup/);
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    assert.equal((await readArtifactBytes(fixture.target)).toString('utf8'), fixture.bytes.get('project')!.toString('utf8'));
    assert.equal((await fs.readdir(transactionRoot)).length, 1);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a committed move with a tampered backup fails startup closed without deleting evidence', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    const transactionRoot = path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    await fs.appendFile(path.join(transactionRoot, id!, 'project.old'), '\ntampered');

    await assert.rejects(initializeFilesystemProjectTransactions(fixture.root), /Invalid project move backup/);
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    await assertGeneration(fixture, 'next');
    assert.equal((await fs.readdir(transactionRoot)).length, 1);
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('unexpected evidence beside a committed move journal blocks readiness', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'committed') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    const transactionRoot = path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    const surprisePath = path.join(transactionRoot, id!, 'surprise');
    await fs.writeFile(surprisePath, 'unrecognized');

    await assert.rejects(initializeFilesystemProjectTransactions(fixture.root), /Unexpected project move recovery evidence/);
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    assert.equal((await readArtifactBytes(surprisePath)).toString('utf8'), 'unrecognized');
    await assertGeneration(fixture, 'next');
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a corrupt prepared journal blocks startup and preserves its directory', async () => {
  const fixture = await createFixture();
  try {
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'prepared') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, fixture.target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    const transactionRoot = path.join(fixture.root, FILESYSTEM_PROJECT_MOVE_TRANSACTIONS_DIR);
    const [id] = await fs.readdir(transactionRoot);
    await fs.writeFile(path.join(transactionRoot, id!, 'journal.json'), '{invalid');
    await assert.rejects(initializeFilesystemProjectTransactions(fixture.root), /recovery failed/);
    assert.throws(() => checkFilesystemProjectTransactionHealth(fixture.root), /recovery failed closed/);
    assert.deepEqual(await fs.readdir(transactionRoot), [id]);
    await assertGeneration(fixture, 'old');
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('move preserves project and settings permissions on Unix', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createFixture();
  try {
    await fs.chmod(fixture.source, 0o640);
    await fs.chmod(artifactPath(fixture.source, 'settings'), 0o600);
    await moveProjectWithSidecars(fixture.root, fixture.source, fixture.target);
    assert.equal((await fs.stat(fixture.target)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(artifactPath(fixture.target, 'settings'))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('Windows case-only rename keeps one exact set of artifact names', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await createFixture();
  try {
    const target = path.join(path.dirname(fixture.source), 'published.rivet-project');
    await moveProjectWithSidecars(fixture.root, fixture.source, target);
    const entries = await fs.readdir(path.dirname(target));
    for (const kind of kinds) {
      assert.equal(entries.includes(path.basename(artifactPath(fixture.source, kind))), false);
      if (kind !== 'stats') assert.equal(entries.includes(path.basename(artifactPath(target, kind))), true);
    }
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('Windows case-only rename restores original names after an interrupted promotion', { skip: process.platform !== 'win32' }, async () => {
  const fixture = await createFixture();
  try {
    const target = path.join(path.dirname(fixture.source), 'published.rivet-project');
    setFilesystemProjectMoveCheckpointForTests((checkpoint) => {
      if (checkpoint === 'promoted') throw new FilesystemProjectMoveInterruption(checkpoint);
    });
    await assert.rejects(moveProjectWithSidecars(fixture.root, fixture.source, target), FilesystemProjectMoveInterruption);
    setFilesystemProjectMoveCheckpointForTests(null);
    await initializeFilesystemProjectTransactions(fixture.root);
    const entries = await fs.readdir(path.dirname(target));
    for (const kind of kinds) {
      assert.equal(entries.includes(path.basename(artifactPath(fixture.source, kind))), true);
      assert.equal(entries.includes(path.basename(artifactPath(target, kind))), false);
    }
  } finally {
    setFilesystemProjectMoveCheckpointForTests(null);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});
