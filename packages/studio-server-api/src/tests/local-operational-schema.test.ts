import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';
import {
  assertEmptyLocalOperationalDatabase,
  assertLocalOperationalSchema,
} from '../local-metadata/operational-schema.js';

async function fixture(run: (database: DatabaseSync) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-operational-schema-'));
  const file = path.join(root, 'health.sqlite');
  const store = new FilesystemRivetLLMProfileHealthStore(file);
  try {
    await store.list();
    await store.dispose();
    const database = new DatabaseSync(file);
    try {
      run(database);
    } finally {
      database.close();
    }
  } finally {
    await store.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('selected operational schema fails closed without recreating missing authority', async () => {
  await fixture((database) => {
    assertLocalOperationalSchema(database, 'health');
    database.exec('DROP TABLE llm_profile_health');
    assert.throws(() => assertLocalOperationalSchema(database, 'health'), /unexpected or missing tables/);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'llm_profile_health'").get(), undefined);
  });
});

test('an absent source domain cannot certify extra rows or an unrelated candidate table', async () => {
  await fixture((database) => {
    assertEmptyLocalOperationalDatabase(database, 'health');
    database.exec("INSERT INTO llm_profile_health VALUES ('unexpected', 'project', '{}', 1)");
    assert.throws(() => assertEmptyLocalOperationalDatabase(database, 'health'), /unexpected candidate records/);
    database.exec('DELETE FROM llm_profile_health; CREATE TABLE unrelated (id INTEGER)');
    assert.throws(() => assertEmptyLocalOperationalDatabase(database, 'health'), /unexpected or missing tables/);
  });
});
