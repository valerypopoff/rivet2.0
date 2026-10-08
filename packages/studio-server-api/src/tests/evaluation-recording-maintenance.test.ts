// test-style: fixture-read: inspects only this test's operational database and maintenance marker.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import type { EvaluationRecordingArtifact } from '@valerypopoff/rivet2-evaluations';
import { FilesystemRivetEvaluationStore } from '../evaluation-runs/filesystem-store.js';
import { installLocalMetadataServingSelection } from '../local-metadata/serving-selection.js';

test('saving an Evaluation recording bounds project cleanup and leaves reads pure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-evaluation-write-cleanup-'));
  const file = path.join(root, 'evaluation-runs.sqlite');
  const projectId = 'fixture-project' as ProjectId;
  const store = new FilesystemRivetEvaluationStore(file);
  let database: DatabaseSync | undefined;
  try {
    await store.list({ projectId });
    database = new DatabaseSync(file);
    const insert = database.prepare('INSERT INTO evaluation_recordings VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < 151; index++) {
      insert.run(
        projectId,
        `expired-${index}`,
        'run',
        JSON.stringify({
          reference: { retention: 'temporary', expiresAt: '2000-01-01T00:00:00Z' },
        }),
        1,
      );
    }
    insert.run(
      'foreign-project',
      'foreign',
      'run',
      JSON.stringify({
        reference: { retention: 'temporary', expiresAt: '2000-01-01T00:00:00Z' },
      }),
      1,
    );
    const fresh: EvaluationRecordingArtifact = {
      projectId,
      runId: 'fresh-run',
      trialId: 'trial',
      reference: { id: 'fresh', retention: 'retained' },
      serialized: 'recording',
      createdAt: new Date().toISOString(),
    };
    await store.putRecording(fresh);
    const count = () => database!.prepare('SELECT COUNT(*) AS n FROM evaluation_recordings').get()!.n;
    assert.equal(count(), 53);
    assert.ok(database.prepare("SELECT 1 FROM evaluation_recordings WHERE project_id = 'foreign-project'").get());
    await store.list({ projectId });
    await store.getRecording({ projectId, recordingId: 'fresh' });
    assert.equal(count(), 53, 'reads do not drain the remaining backlog');
  } finally {
    await store.dispose();
    database?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const useSelected of [false, true]) {
  test(`${useSelected ? 'selected SQLite' : 'legacy storage'} bounds Evaluation cleanup and respects maintenance`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-selected-evaluation-maintenance-'));
    const file = path.join(root, 'evaluation-runs.sqlite');
    const projectId = 'fixture-project' as ProjectId;
    const originalControl = process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
    const originalAppData = process.env.RIVET_APP_DATA_ROOT;
    process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = '';
    const legacy = new FilesystemRivetEvaluationStore(file);
    let selected: FilesystemRivetEvaluationStore | undefined;
    let database: DatabaseSync | undefined;
    try {
      await legacy.list({ projectId });
      await legacy.dispose();
      database = new DatabaseSync(file);
      database.exec('DROP INDEX evaluation_recordings_temporary_expiry_idx');
      for (let index = 0; index < 102; index++) {
        const retention = index === 101 ? 'retained' : 'temporary';
        database
          .prepare('INSERT INTO evaluation_recordings VALUES (?, ?, ?, ?, ?)')
          .run(
            projectId,
            `${retention}-${index}`,
            'run',
            JSON.stringify({ reference: { retention, expiresAt: '2000-01-01T00:00:00Z' } }),
            1,
          );
      }
      if (useSelected)
        installLocalMetadataServingSelection({
          generationId: 'fixture',
          catalogDatabasePath: path.join(root, 'catalog.sqlite'),
          settingsDatabasePath: path.join(root, 'settings.sqlite'),
          artifactRoot: root,
          operationalRoot: root,
          runtimeCacheRoot: root,
          source: { workflows: root, recordings: root, appData: root, runtimeLibraries: root },
        });
      const marker = path.join(root, 'vm-migration-maintenance.json');
      await fs.writeFile(marker, JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }));
      // The HTTP migration barrier also supports legacy storage with no control
      // journal. Its maintenance marker alone must fence the background timer.
      process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = useSelected ? root : '';
      process.env.RIVET_APP_DATA_ROOT = root;
      t.mock.timers.enable({ apis: ['setInterval'] });
      selected = new FilesystemRivetEvaluationStore(file);
      await selected.list({ projectId });
      t.mock.timers.tick(60_000);
      const count = () => database!.prepare('SELECT COUNT(*) AS n FROM evaluation_recordings').get()!.n;
      assert.equal(count(), 102);
      assert.equal(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'evaluation_recordings_temporary_expiry_idx'").get(),
        undefined,
      );
      // Remove the fixture's barrier and disable journal admission, just as this
      // fixture did during initial schema creation. No production journal is used.
      await fs.unlink(marker);
      process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = '';
      t.mock.timers.tick(60_000);
      assert.equal(count(), 2, 'one timer pass deletes at most 100 expired rows');
      t.mock.timers.tick(60_000);
      assert.equal(count(), 1);
      assert.equal(
        database.prepare('SELECT recording_id FROM evaluation_recordings').get()!.recording_id,
        'retained-101',
      );
      assert.ok(
        database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'evaluation_recordings_temporary_expiry_idx'").get(),
      );
      await selected.dispose();
      t.mock.timers.tick(60_000);
      assert.equal(count(), 1);
    } finally {
      await selected?.dispose();
      await legacy.dispose();
      database?.close();
      t.mock.timers.reset();
      if (originalControl === undefined) delete process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT;
      else process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT = originalControl;
      if (originalAppData === undefined) delete process.env.RIVET_APP_DATA_ROOT;
      else process.env.RIVET_APP_DATA_ROOT = originalAppData;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
