import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import { runDeduplicatedProjectSave } from './projectSaveCoordinator.js';

test('shares one in-flight save promise for the same project', async () => {
  const workspace = {};
  const projectId = 'project-a' as ProjectId;
  let persistenceCount = 0;
  let finishSave!: (saved: boolean) => void;
  const pendingSave = new Promise<boolean>((resolve) => {
    finishSave = resolve;
  });

  const first = runDeduplicatedProjectSave(workspace, projectId, () => {
    persistenceCount += 1;
    return pendingSave;
  });
  const second = runDeduplicatedProjectSave(workspace, projectId, () => {
    persistenceCount += 1;
    return Promise.resolve(false);
  });

  assert.strictEqual(second, first);
  assert.equal(persistenceCount, 1);

  finishSave(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  await Promise.resolve();
  const third = runDeduplicatedProjectSave(workspace, projectId, async () => {
    persistenceCount += 1;
    return true;
  });
  assert.notStrictEqual(third, first);
  assert.equal(await third, true);
  assert.equal(persistenceCount, 2);
});

test('does not deduplicate saves for different projects', async () => {
  const workspace = {};
  let persistenceCount = 0;
  const save = async () => {
    persistenceCount += 1;
    return true;
  };

  const first = runDeduplicatedProjectSave(workspace, 'project-a' as ProjectId, save);
  const second = runDeduplicatedProjectSave(workspace, 'project-b' as ProjectId, save);

  assert.notStrictEqual(second, first);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(persistenceCount, 2);
});

test('does not deduplicate identical project IDs owned by different workspaces', async () => {
  const projectId = 'shared-project-id' as ProjectId;
  let persistenceCount = 0;
  const save = async () => {
    persistenceCount += 1;
    return true;
  };

  const first = runDeduplicatedProjectSave({}, projectId, save);
  const second = runDeduplicatedProjectSave({}, projectId, save);

  assert.notStrictEqual(second, first);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(persistenceCount, 2);
});

test('allows a later save after false and rejected results', async () => {
  const workspace = {};
  const projectId = 'project-a' as ProjectId;
  let persistenceCount = 0;

  assert.equal(
    await runDeduplicatedProjectSave(workspace, projectId, async () => {
      persistenceCount += 1;
      return false;
    }),
    false,
  );

  await assert.rejects(
    runDeduplicatedProjectSave(workspace, projectId, async () => {
      persistenceCount += 1;
      throw new Error('failed save');
    }),
    /failed save/,
  );

  assert.equal(
    await runDeduplicatedProjectSave(workspace, projectId, async () => {
      persistenceCount += 1;
      return true;
    }),
    true,
  );
  assert.equal(persistenceCount, 3);
});
