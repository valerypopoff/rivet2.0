import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FilesystemProjectTransactionCleanupPendingError,
  FilesystemProjectTransactionInterruption,
  FILESYSTEM_PROJECT_TRANSACTIONS_DIR,
  initializeFilesystemProjectTransactions,
  recoverFilesystemProjectTransactions,
  resetFilesystemProjectTransactionStateForTests,
  saveFilesystemProjectTransaction,
  type FilesystemProjectTransactionCheckpoint,
  withFilesystemWorkflowStorageRead,
  withFilesystemWorkflowStorageWrite,
} from '../routes/workflows/filesystem-project-transactions.js';
import { createBlankProjectFile, getWorkflowDatasetPath } from '../routes/workflows/fs-helpers.js';
import { loadProjectAndAttachedDataFromString, serializeDatasets, serializeProject } from '@valerypopoff/rivet2-node';

const preCommitCheckpoints: FilesystemProjectTransactionCheckpoint[] = [
  'staged-project',
  'staged-dataset',
  'prepared',
  'project-backed-up',
  'dataset-backed-up',
  'project-promoted',
  'dataset-applied',
  'validated',
];

const postCommitCheckpoints: FilesystemProjectTransactionCheckpoint[] = ['committed', 'cleanup'];

function createProjectGeneration(title: string, source?: string): string {
  if (!source) return createBlankProjectFile(title);
  const [project, attachedData] = loadProjectAndAttachedDataFromString(source);
  project.metadata.title = title;
  return serializeProject(project, attachedData) as string;
}

function createDatasetsGeneration(value: string): string {
  return serializeDatasets([
    {
      meta: {
        id: 'dataset-1' as never,
        projectId: 'project-1' as never,
        name: 'Transaction fixture',
        description: '',
      },
      data: {
        id: 'dataset-1' as never,
        rows: [{ id: 'row-1', data: [value] }],
      },
    },
  ]);
}

async function createFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-project-transactions-'));
  const root = path.join(tempRoot, 'workflows');
  const projectPath = path.join(root, 'Unicode', '深い', 'Project.rivet-project');
  const datasetPath = getWorkflowDatasetPath(projectPath);
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  const oldProject = createProjectGeneration('Old generation');
  const newProject = createProjectGeneration('New generation', oldProject);
  const oldDataset = createDatasetsGeneration('old');
  const newDataset = createDatasetsGeneration('new');
  await fs.writeFile(projectPath, oldProject, 'utf8');
  await fs.writeFile(datasetPath, oldDataset, 'utf8');
  await initializeFilesystemProjectTransactions(root);
  return { tempRoot, root, projectPath, datasetPath, oldProject, newProject, oldDataset, newDataset };
}

async function assertGeneration(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  projectContents: string,
  datasetContents: string | null,
): Promise<void> {
  assert.equal(await fs.readFile(fixture.projectPath, 'utf8'), projectContents);
  if (datasetContents == null) {
    await assert.rejects(fs.readFile(fixture.datasetPath), { code: 'ENOENT' });
  } else {
    assert.equal(await fs.readFile(fixture.datasetPath, 'utf8'), datasetContents);
  }
}

for (const checkpoint of [...preCommitCheckpoints, ...postCommitCheckpoints]) {
  test(`restart recovery resolves an interruption at ${checkpoint} to one complete generation`, async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        saveFilesystemProjectTransaction({
          root: fixture.root,
          projectPath: fixture.projectPath,
          projectContents: fixture.newProject,
          datasetsContents: fixture.newDataset,
          onCheckpoint: (current) => {
            if (current === checkpoint) throw new FilesystemProjectTransactionInterruption(current);
          },
        }),
        FilesystemProjectTransactionInterruption,
      );

      await recoverFilesystemProjectTransactions(fixture.root);
      if (preCommitCheckpoints.includes(checkpoint)) {
        await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
      } else {
        await assertGeneration(fixture, fixture.newProject, fixture.newDataset);
      }
      await assert.rejects(fs.stat(path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR)), { code: 'ENOENT' });
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
}

test('ordinary pre-commit failures roll back before returning the error', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'project-promoted') throw new Error('injected write failure');
        },
      }),
      /injected write failure/,
    );
    await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('dataset addition, replacement, and deletion commit with the project generation', async () => {
  const fixture = await createFixture();
  try {
    await saveFilesystemProjectTransaction({
      root: fixture.root,
      projectPath: fixture.projectPath,
      projectContents: fixture.newProject,
      datasetsContents: fixture.newDataset,
    });
    await assertGeneration(fixture, fixture.newProject, fixture.newDataset);

    const thirdProject = createProjectGeneration('Without dataset', fixture.newProject);
    await saveFilesystemProjectTransaction({
      root: fixture.root,
      projectPath: fixture.projectPath,
      projectContents: thirdProject,
      datasetsContents: null,
    });
    await assertGeneration(fixture, thirdProject, null);

    const fourthProject = createProjectGeneration('Dataset restored', thirdProject);
    await saveFilesystemProjectTransaction({
      root: fixture.root,
      projectPath: fixture.projectPath,
      projectContents: fourthProject,
      datasetsContents: fixture.oldDataset,
    });
    await assertGeneration(fixture, fourthProject, fixture.oldDataset);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

for (const checkpoint of ['dataset-applied', 'committed'] as const) {
  test(`dataset removal recovers the ${checkpoint === 'committed' ? 'new' : 'old'} generation after ${checkpoint}`, async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        saveFilesystemProjectTransaction({
          root: fixture.root,
          projectPath: fixture.projectPath,
          projectContents: fixture.newProject,
          datasetsContents: null,
          onCheckpoint: (current) => {
            if (current === checkpoint) throw new FilesystemProjectTransactionInterruption(current);
          },
        }),
        FilesystemProjectTransactionInterruption,
      );

      await recoverFilesystemProjectTransactions(fixture.root);
      if (checkpoint === 'committed') {
        await assertGeneration(fixture, fixture.newProject, null);
      } else {
        await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
      }
    } finally {
      await fs.rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });
}

test('staged corruption is detected and the old generation is restored', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: async (checkpoint) => {
          if (checkpoint !== 'prepared') return;
          const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
          const [transactionId] = await fs.readdir(transactionsRoot);
          assert.ok(transactionId);
          await fs.writeFile(path.join(transactionsRoot, transactionId, 'project.new'), 'corrupt staged project');
        },
      }),
      /checksum validation/,
    );
    await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('failed first-time creation recovers to complete absence', async () => {
  const fixture = await createFixture();
  const projectPath = path.join(fixture.root, 'First save.rivet-project');
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath,
        projectContents: createProjectGeneration('First save'),
        datasetsContents: createDatasetsGeneration('first'),
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'dataset-applied') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );
    await recoverFilesystemProjectTransactions(fixture.root);
    await assert.rejects(fs.stat(projectPath), { code: 'ENOENT' });
    await assert.rejects(fs.stat(getWorkflowDatasetPath(projectPath)), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('invalid project and dataset payloads fail before canonical artifacts change', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: 'not a Rivet project',
        datasetsContents: fixture.newDataset,
      }),
    );
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: '{invalid',
      }),
    );
    await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
    assert.ok(warnings.length > 0, 'invalid project diagnostics should be emitted');
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a save path outside the workflow root is rejected before callbacks or directory creation', async () => {
  const fixture = await createFixture();
  const outsideProjectPath = path.join(fixture.tempRoot, 'outside', 'Project.rivet-project');
  let beforeTransactionCalled = false;
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: outsideProjectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        beforeTransaction: () => {
          beforeTransactionCalled = true;
        },
      }),
      /beneath the workflow root/,
    );
    assert.equal(beforeTransactionCalled, false);
    await assert.rejects(fs.stat(path.dirname(outsideProjectPath)), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a non-project save target is rejected before callbacks or directory creation', async () => {
  const fixture = await createFixture();
  const nonProjectPath = path.join(fixture.root, 'new', 'not-a-project.txt');
  let beforeTransactionCalled = false;
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: nonProjectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        beforeTransaction: () => {
          beforeTransactionCalled = true;
        },
      }),
      /must end with \.rivet-project/,
    );
    assert.equal(beforeTransactionCalled, false);
    await assert.rejects(fs.stat(path.dirname(nonProjectPath)), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('startup removes capability-probe residue left by a process crash', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-project-probe-recovery-'));
  const root = path.join(tempRoot, 'workflows');
  const transactionsRoot = path.join(root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
  try {
    await fs.mkdir(transactionsRoot, { recursive: true });
    await fs.writeFile(path.join(transactionsRoot, '.probe-12345678-1234-4123-8123-123456789abc'), 'partial');
    await fs.writeFile(path.join(transactionsRoot, '.probe-abcdefab-cdef-4abc-9def-abcdefabcdef.renamed'), 'complete');

    await initializeFilesystemProjectTransactions(root);

    await assert.rejects(fs.stat(transactionsRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('recovery fails closed and preserves evidence when a backup checksum is wrong', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'project-promoted') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );
    const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
    const [transactionId] = await fs.readdir(transactionsRoot);
    assert.ok(transactionId);
    const transactionPath = path.join(transactionsRoot, transactionId);
    await fs.writeFile(path.join(transactionPath, 'project.old'), 'corrupt evidence', 'utf8');

    await assert.rejects(
      recoverFilesystemProjectTransactions(fixture.root),
      new RegExp(`transaction ${transactionId}`, 'i'),
    );
    assert.equal(await fs.stat(path.join(transactionPath, 'journal.json')).then(() => true), true);
    assert.equal(await fs.readFile(fixture.projectPath, 'utf8'), fixture.newProject);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), new RegExp(transactionId, 'i'));
  } finally {
    resetFilesystemProjectTransactionStateForTests(fixture.root);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('recovery fails closed when a legacy ID-only committed marker has no durable journal', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  const transactionId = '123e4567-e89b-12d3-a456-426614174000';
  const transactionPath = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR, transactionId);
  try {
    await fs.mkdir(transactionPath, { recursive: true });
    await fs.writeFile(path.join(transactionPath, 'committed'), `${transactionId}\n`, 'utf8');

    await assert.rejects(
      recoverFilesystemProjectTransactions(fixture.root),
      new RegExp(`transaction ${transactionId}`, 'i'),
    );
    assert.equal(await fs.stat(path.join(transactionPath, 'committed')).then(() => true), true);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), new RegExp(transactionId, 'i'));
  } finally {
    resetFilesystemProjectTransactionStateForTests(fixture.root);
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a structured committed marker recovers the new generation after cleanup removed its journal', async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'committed') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );

    const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
    const [transactionId] = await fs.readdir(transactionsRoot);
    assert.ok(transactionId);
    const transactionPath = path.join(transactionsRoot, transactionId);
    await fs.unlink(path.join(transactionPath, 'journal.json'));

    await recoverFilesystemProjectTransactions(fixture.root);
    await assertGeneration(fixture, fixture.newProject, fixture.newDataset);
    await assert.rejects(fs.stat(transactionsRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a post-commit finalization failure leaves the new generation committed and recoverable', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  try {
    await saveFilesystemProjectTransaction({
      root: fixture.root,
      projectPath: fixture.projectPath,
      projectContents: fixture.newProject,
      datasetsContents: fixture.newDataset,
      afterCommit: () => {
        throw new Error('derived cache unavailable');
      },
    });

    await assertGeneration(fixture, fixture.newProject, fixture.newDataset);
    assert.equal(errors.length, 1);
    await recoverFilesystemProjectTransactions(fixture.root);
    await assert.rejects(fs.stat(path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR)), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('committed cleanup residue is retained and retried without blocking startup recovery', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'committed') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );
    const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
    const [transactionId] = await fs.readdir(transactionsRoot);
    assert.ok(transactionId);
    const transactionPath = path.join(transactionsRoot, transactionId);
    const unexpectedPath = path.join(transactionPath, 'unexpected-leftover');
    await fs.writeFile(unexpectedPath, 'preserve the journal', 'utf8');

    await initializeFilesystemProjectTransactions(fixture.root);
    await assertGeneration(fixture, fixture.newProject, fixture.newDataset);
    assert.equal(await fs.stat(path.join(transactionPath, 'journal.json')).then(() => true), true);
    assert.equal(await fs.stat(path.join(transactionPath, 'committed')).then(() => true), true);
    assert.equal(errors.length, 1);

    await fs.unlink(unexpectedPath);
    await recoverFilesystemProjectTransactions(fixture.root);
    await assert.rejects(fs.stat(transactionsRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('rolled-back cleanup residue is retained and retried without blocking startup recovery', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'project-promoted') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );
    const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
    const [transactionId] = await fs.readdir(transactionsRoot);
    assert.ok(transactionId);
    const transactionPath = path.join(transactionsRoot, transactionId);
    const unexpectedPath = path.join(transactionPath, 'unexpected-leftover');
    await fs.writeFile(unexpectedPath, 'preserve the journal', 'utf8');

    await initializeFilesystemProjectTransactions(fixture.root);
    await assertGeneration(fixture, fixture.oldProject, fixture.oldDataset);
    assert.equal(await fs.stat(path.join(transactionPath, 'journal.json')).then(() => true), true);
    assert.equal(errors.length, 1);

    await fs.unlink(unexpectedPath);
    await recoverFilesystemProjectTransactions(fixture.root);
    await assert.rejects(fs.stat(transactionsRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('a later save waits for cleanup of the previous transaction evidence', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
  const fixture = await createFixture();
  const thirdProject = createProjectGeneration('Third generation', fixture.newProject);
  try {
    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: fixture.newProject,
        datasetsContents: fixture.newDataset,
        onCheckpoint: (checkpoint) => {
          if (checkpoint === 'committed') throw new FilesystemProjectTransactionInterruption(checkpoint);
        },
      }),
      FilesystemProjectTransactionInterruption,
    );
    const transactionsRoot = path.join(fixture.root, FILESYSTEM_PROJECT_TRANSACTIONS_DIR);
    const [transactionId] = await fs.readdir(transactionsRoot);
    assert.ok(transactionId);
    const transactionPath = path.join(transactionsRoot, transactionId);
    const unexpectedPath = path.join(transactionPath, 'unexpected-leftover');
    await fs.writeFile(unexpectedPath, 'preserve the journal', 'utf8');

    await assert.rejects(
      saveFilesystemProjectTransaction({
        root: fixture.root,
        projectPath: fixture.projectPath,
        projectContents: thirdProject,
        datasetsContents: fixture.newDataset,
      }),
      FilesystemProjectTransactionCleanupPendingError,
    );
    await assertGeneration(fixture, fixture.newProject, fixture.newDataset);
    assert.equal(errors.length, 1);

    await fs.unlink(unexpectedPath);
    await recoverFilesystemProjectTransactions(fixture.root);
    await saveFilesystemProjectTransaction({
      root: fixture.root,
      projectPath: fixture.projectPath,
      projectContents: thirdProject,
      datasetsContents: fixture.newDataset,
    });
    await assertGeneration(fixture, thirdProject, fixture.newDataset);
  } finally {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  }
});

test('filesystem reads wait until an active write operation releases', async () => {
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const writeStartedPromise = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  const releaseWritePromise = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const order: string[] = [];

  const write = withFilesystemWorkflowStorageWrite(async () => {
    order.push('write-start');
    writeStarted();
    await releaseWritePromise;
    order.push('write-end');
  });
  await writeStartedPromise;
  const read = withFilesystemWorkflowStorageRead(async () => {
    order.push('read');
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['write-start']);
  releaseWrite();
  await Promise.all([write, read]);
  assert.deepEqual(order, ['write-start', 'write-end', 'read']);
});
