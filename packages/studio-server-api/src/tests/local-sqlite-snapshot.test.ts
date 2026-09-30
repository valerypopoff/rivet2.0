import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createVerifiedLocalSqliteSnapshot, inspectLocalSqliteSnapshot } from '../local-metadata/sqlite-snapshot.js';

// test-style: fixture-read: Reads compare only generated SQLite/WAL fixtures, not repository source.

async function fixture(
  run: (root: string, source: string, destination: string, writer: DatabaseSync) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-sqlite-snapshot-'));
  const source = path.join(root, 'source.sqlite');
  const destination = path.join(root, 'backup.sqlite');
  const writer = new DatabaseSync(source);
  try {
    writer.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, secret TEXT, payload BLOB);
      INSERT INTO records (id, secret, payload) VALUES (9007199254740993, 'never print this', X'00ff');`);
    await run(root, source, destination, writer);
  } finally {
    writer.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('SQLite backup includes committed WAL, blobs, large integers and sequence state without source mutation', async () => {
  await fixture(async (_root, sourcePath, destinationPath) => {
    const sourceBytes = await fs.readFile(sourcePath);
    const walBytes = await fs.readFile(`${sourcePath}-wal`);
    const proof = await createVerifiedLocalSqliteSnapshot({
      sourcePath,
      destinationPath,
      assertFrozen: async () => {},
    });
    assert.deepEqual(proof, await inspectLocalSqliteSnapshot(sourcePath));
    assert.deepEqual(proof.tables, [
      { name: 'records', rows: 1 },
      { name: 'sqlite_sequence', rows: 1 },
    ]);
    assert.ok(!JSON.stringify(proof).includes('never print this'));
    assert.deepEqual(await fs.readFile(sourcePath), sourceBytes);
    assert.deepEqual(await fs.readFile(`${sourcePath}-wal`), walBytes);
    assert.deepEqual(
      await createVerifiedLocalSqliteSnapshot({ sourcePath, destinationPath, assertFrozen: async () => {} }),
      proof,
    );
  });
});

test('SQLite backup retries reject extra target rows without replacing the previous backup', async () => {
  await fixture(async (_root, sourcePath, destinationPath) => {
    await createVerifiedLocalSqliteSnapshot({ sourcePath, destinationPath, assertFrozen: async () => {} });
    const extra = new DatabaseSync(destinationPath);
    extra.exec("INSERT INTO records (secret) VALUES ('unexpected')");
    extra.close();
    const before = await fs.readFile(destinationPath);
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({ sourcePath, destinationPath, assertFrozen: async () => {} }),
      /differs/,
    );
    assert.deepEqual(await fs.readFile(destinationPath), before);
  });
});

test('SQLite snapshot proofs distinguish non-finite real values and ignore collation tie insertion order', async () => {
  await fixture(async (_root, sourcePath, destinationPath, writer) => {
    writer.exec(
      "CREATE TABLE values_table (value, label TEXT COLLATE NOCASE); INSERT INTO values_table VALUES (1e999, 'a'), (1, 'A'), (1.0, 'A');",
    );
    const proof = await createVerifiedLocalSqliteSnapshot({
      sourcePath,
      destinationPath,
      assertFrozen: async () => {},
    });
    const backup = new DatabaseSync(destinationPath);
    try {
      backup.exec("DELETE FROM values_table; INSERT INTO values_table VALUES (1.0, 'A'), (1, 'A'), (1e999, 'a');");
      assert.equal((await inspectLocalSqliteSnapshot(destinationPath)).logicalHash, proof.logicalHash);
      backup.exec('UPDATE values_table SET value = -1e999 WHERE value = 1e999');
      assert.notEqual((await inspectLocalSqliteSnapshot(destinationPath)).logicalHash, proof.logicalHash);
      await assert.rejects(
        createVerifiedLocalSqliteSnapshot({ sourcePath, destinationPath, assertFrozen: async () => {} }),
        /differs/,
      );
    } finally {
      backup.close();
    }
  });
});

test('SQLite backup rejects missing or corrupt sources, unsafe paths and an absent maintenance fence', async () => {
  await fixture(async (root, sourcePath, destinationPath) => {
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({ sourcePath, destinationPath: sourcePath, assertFrozen: async () => {} }),
      /replace its source/,
    );
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({
        sourcePath,
        destinationPath,
        assertFrozen: async () => {
          throw new Error('not frozen');
        },
      }),
      /not frozen/,
    );
    await assert.rejects(fs.stat(destinationPath), { code: 'ENOENT' });
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({
        sourcePath: path.join(root, 'missing'),
        destinationPath,
        assertFrozen: async () => {},
      }),
      { code: 'ENOENT' },
    );
    const corrupt = path.join(root, 'corrupt');
    await fs.writeFile(corrupt, 'not a database');
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({ sourcePath: corrupt, destinationPath, assertFrozen: async () => {} }),
    );
    await assert.rejects(fs.stat(destinationPath), { code: 'ENOENT' });
  });
});

test('SQLite backup detects committed source drift and leaves a diagnostic snapshot rather than certifying it', async () => {
  await fixture(async (_root, sourcePath, destinationPath, writer) => {
    let calls = 0;
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({
        sourcePath,
        destinationPath,
        assertFrozen: async () => {
          if (++calls === 4) writer.exec("INSERT INTO records (secret) VALUES ('late writer')");
        },
      }),
      /source changed/,
    );
    assert.notEqual(
      (await inspectLocalSqliteSnapshot(sourcePath)).logicalHash,
      (await inspectLocalSqliteSnapshot(destinationPath)).logicalHash,
    );
  });
});

test('SQLite backup rejects a symlinked destination directory without writing through it', async (context) => {
  await fixture(async (root, sourcePath) => {
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    await fs.mkdir(real);
    try {
      await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip('Windows symlink privilege unavailable; Linux exercises the path check.');
        return;
      }
      throw error;
    }
    await assert.rejects(
      createVerifiedLocalSqliteSnapshot({
        sourcePath,
        destinationPath: path.join(alias, 'backup.sqlite'),
        assertFrozen: async () => {},
      }),
      /unsafe parent/,
    );
    assert.deepEqual(await fs.readdir(real), []);
  });
});
