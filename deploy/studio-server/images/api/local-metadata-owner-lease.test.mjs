import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { acquireLocalMetadataOwnerLease, assertLegacyLocalMetadataStartup } from './local-metadata-owner-lease.mjs';

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-owner-lease-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('local owner lease excludes competing backend, converter and recovery processes until released', async () => {
  await fixture(async (root) => {
    assert.throws(() => acquireLocalMetadataOwnerLease(root, { requireExisting: true }), /previously provisioned/);
    const owner = acquireLocalMetadataOwnerLease(root);
    try {
      assert.throws(() => acquireLocalMetadataOwnerLease(root), /Another backend/);
    } finally {
      owner.release();
      owner.release();
    }
    const recovery = acquireLocalMetadataOwnerLease(root, { requireExisting: true });
    recovery.release();
  });
});

test('local owner lock releases on process termination without deleting a stale PID file', async () => {
  await fixture(async (root) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const { acquireLocalMetadataOwnerLease } = await import(${JSON.stringify(import.meta.resolve('./local-metadata-owner-lease.mjs'))});
      acquireLocalMetadataOwnerLease(${JSON.stringify(root)});
      process.send('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owner child did not initialize')), 10000);
        child.once('message', () => {
          clearTimeout(timer);
          resolve();
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Owner child exited before ready'));
        });
      });
      assert.throws(() => acquireLocalMetadataOwnerLease(root), /Another backend/);
      const done = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await done;
      acquireLocalMetadataOwnerLease(root, { requireExisting: true }).release();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

test('local owner lease rejects damaged or unrelated databases instead of resetting them', async () => {
  await fixture(async (root) => {
    const db = new DatabaseSync(path.join(root, 'owner-lock.sqlite'));
    db.exec('CREATE TABLE unrelated (secret TEXT)');
    db.close();
    assert.throws(() => acquireLocalMetadataOwnerLease(root), /damaged or incompatible/);
  });
});

test('startup does not fall back to legacy files when a SQLite generation is selected', async () => {
  await fixture(async (root) => {
    assert.throws(() => assertLegacyLocalMetadataStartup(root, root), /missing; refusing/);
    const db = new DatabaseSync(path.join(root, 'transition.sqlite'));
    db.exec(
      "PRAGMA application_id = 1380537418; PRAGMA user_version = 1; CREATE TABLE transition_state (phase TEXT, generation_id TEXT, revision INTEGER); INSERT INTO transition_state VALUES ('sqlite-validation', 'generation-1', 3)",
    );
    db.close();
    assert.throws(() => assertLegacyLocalMetadataStartup(root, root), /cannot yet serve/);
    const resumed = new DatabaseSync(path.join(root, 'transition.sqlite'));
    resumed.exec("UPDATE transition_state SET phase = 'legacy-validation'");
    resumed.close();
    assert.throws(() => assertLegacyLocalMetadataStartup(root, root), /ENOENT/);
    await fs.writeFile(path.join(root, 'vm-migration-maintenance.json'), '{"version":1}');
    assert.throws(() => assertLegacyLocalMetadataStartup(root, root), /invalid maintenance/);
    await fs.writeFile(
      path.join(root, 'vm-migration-maintenance.json'),
      JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }),
    );
    assert.doesNotThrow(() => assertLegacyLocalMetadataStartup(root, root));
    const selected = new DatabaseSync(path.join(root, 'transition.sqlite'));
    selected.exec("UPDATE transition_state SET phase = 'sqlite-validation'");
    selected.close();
    assert.deepEqual(assertLegacyLocalMetadataStartup(root, root, { allowSqlite: true }), {
      phase: 'sqlite-validation',
      revision: 3,
      generationId: 'generation-1',
    });
  });
});
