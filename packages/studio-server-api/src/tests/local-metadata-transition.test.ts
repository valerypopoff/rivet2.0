import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  LocalMetadataTransitionJournal,
  type LocalMetadataGenerationProof,
} from '../local-metadata/transition-journal.js';

// test-style: fixture-read: reads only generated temporary legacy settings to prove rollback leaves them unchanged.

const proof: LocalMetadataGenerationProof = {
  id: 'generation-1',
  sourceIdentity: '1'.repeat(64),
  candidateIdentity: '2'.repeat(64),
  sourceFingerprint: 'a'.repeat(64),
  candidateFingerprint: 'b'.repeat(64),
  reportHash: 'c'.repeat(64),
};

async function fixture(
  run: (journal: LocalMetadataTransitionJournal, databasePath: string, root: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-local-transition-'));
  const databasePath = path.join(root, 'transition.sqlite');
  const journal = new LocalMetadataTransitionJournal(databasePath);
  try {
    await journal.initialize({ create: true });
    await run(journal, databasePath, root);
  } finally {
    journal.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('SQLite validation can return to untouched legacy data without depending on the failed candidate', async () => {
  await fixture(async (journal, databasePath, root) => {
    const oldFile = path.join(root, 'original-settings.json');
    const original = '{"secret":"original-value"}';
    await fs.writeFile(oldFile, original);
    const initial = journal.read();
    assert.equal(initial.backend, 'legacy');
    assert.equal(initial.paused, false);
    const verified = journal.recordVerifiedCandidate(initial.revision, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    assert.equal(selected.backend, 'sqlite');
    assert.equal(selected.paused, true);
    assert.equal(selected.canReturnToLegacy, true);
    assert.throws(() => journal.resumeWrites(selected.revision, proof), /remain paused/);
    journal.close();

    // Simulate an unhealthy/missing candidate and a restarted operator owner.
    // Recovery reads only the independent journal and the retained source proof.
    const reopened = new LocalMetadataTransitionJournal(databasePath);
    try {
      await reopened.initialize();
      assert.equal(reopened.read().phase, 'sqlite-validation');
      const returned = reopened.returnToLegacy(reopened.read().revision, proof);
      assert.equal(returned.backend, 'legacy');
      assert.equal(returned.paused, true);
      assert.throws(() => reopened.selectSqliteForValidation(returned.revision, proof), /verified candidate/);
      assert.throws(() => reopened.resumeWrites(returned.revision, proof), /remain paused/);
      const checked = reopened.recordRuntimeValidation(returned.revision, 'legacy', proof.id, 'd'.repeat(64));
      const resumed = reopened.resumeWrites(checked.revision, {
        sourceIdentity: proof.sourceIdentity,
        sourceFingerprint: proof.sourceFingerprint,
      });
      assert.equal(resumed.phase, 'legacy-resumed');
      assert.equal(resumed.paused, false);
      assert.equal(await fs.readFile(oldFile, 'utf8'), original);
    } finally {
      reopened.close();
    }
  });
});

test('SQLite write resumption durably closes rollback even before the first new save', async () => {
  await fixture(async (journal, databasePath) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    assert.throws(
      () => journal.recordRuntimeValidation(selected.revision, 'legacy', proof.id, 'd'.repeat(64)),
      /does not match/,
    );
    assert.throws(
      () => journal.recordRuntimeValidation(selected.revision, 'sqlite', 'another-generation', 'd'.repeat(64)),
      /does not match/,
    );
    const checked = journal.recordRuntimeValidation(selected.revision, 'sqlite', proof.id, 'd'.repeat(64));
    const active = journal.resumeWrites(checked.revision, proof);
    assert.equal(active.backend, 'sqlite');
    assert.equal(active.canReturnToLegacy, false);
    journal.close();
    const reopened = new LocalMetadataTransitionJournal(databasePath);
    try {
      await reopened.initialize();
      assert.equal(reopened.read().phase, 'sqlite-live');
      assert.throws(() => reopened.returnToLegacy(active.revision, proof), /rollback is unavailable/);
      assert.throws(() => reopened.recordVerifiedCandidate(active.revision, { ...proof, id: 'other' }), /in progress/);
    } finally {
      reopened.close();
    }
  });
});

test('drift after runtime validation blocks write resumption without closing rollback', async () => {
  await fixture(async (journal) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    const checked = journal.recordRuntimeValidation(selected.revision, 'sqlite', proof.id, 'd'.repeat(64));
    for (const key of [
      'sourceIdentity',
      'sourceFingerprint',
      'candidateIdentity',
      'candidateFingerprint',
      'reportHash',
    ] as const) {
      assert.throws(
        () => journal.resumeWrites(checked.revision, { ...proof, [key]: 'e'.repeat(64) }),
        /changed.*blocked/,
      );
      assert.deepEqual(journal.read(), checked);
    }
    assert.throws(
      () =>
        journal.resumeWrites(checked.revision, {
          sourceIdentity: proof.sourceIdentity,
          sourceFingerprint: proof.sourceFingerprint,
        }),
      /Invalid.*proof/,
    );
    const returned = journal.returnToLegacy(checked.revision, proof);
    const legacyChecked = journal.recordRuntimeValidation(returned.revision, 'legacy', proof.id, 'd'.repeat(64));
    assert.throws(
      () => journal.resumeWrites(legacyChecked.revision, { ...proof, sourceFingerprint: 'e'.repeat(64) }),
      /Legacy source changed/,
    );
    assert.deepEqual(journal.read(), legacyChecked);
    assert.equal(
      journal.resumeWrites(legacyChecked.revision, {
        sourceIdentity: proof.sourceIdentity,
        sourceFingerprint: proof.sourceFingerprint,
      }).phase,
      'legacy-resumed',
    );
  });
});

test('finishing interrupted resumption advances the durable revision and keeps rollback closed', async () => {
  await fixture(async (journal) => {
    assert.throws(() => journal.requireResumedRestart(1), /resumption/);
    const verified = journal.recordVerifiedCandidate(1, proof);
    const selected = journal.selectSqliteForValidation(verified.revision, proof);
    const checked = journal.recordRuntimeValidation(selected.revision, 'sqlite', proof.id, 'd'.repeat(64));
    const resumed = journal.resumeWrites(checked.revision, proof);
    const fenced = journal.requireResumedRestart(resumed.revision);
    assert.equal(fenced.revision, resumed.revision + 1);
    assert.equal(fenced.phase, 'sqlite-live');
    assert.equal(fenced.canReturnToLegacy, false);
    assert.deepEqual(fenced.generation, resumed.generation);
    assert.throws(() => journal.requireResumedRestart(resumed.revision), /Stale/);
    assert.throws(() => journal.returnToLegacy(fenced.revision, proof), /rollback is unavailable/);
  });
});

test('drift, stale operators, and invalid proofs cannot select SQLite or rollback a different source', async () => {
  await fixture(async (journal, databasePath) => {
    const second = new LocalMetadataTransitionJournal(databasePath);
    try {
      await second.initialize();
      const verified = journal.recordVerifiedCandidate(1, proof);
      assert.throws(() => second.recordVerifiedCandidate(1, { ...proof, id: 'second' }), /Stale/);
      for (const key of [
        'sourceIdentity',
        'candidateIdentity',
        'sourceFingerprint',
        'candidateFingerprint',
        'reportHash',
      ] as const) {
        assert.throws(
          () => journal.selectSqliteForValidation(verified.revision, { ...proof, [key]: 'e'.repeat(64) }),
          /changed/,
        );
      }
      assert.throws(
        () => journal.selectSqliteForValidation(verified.revision, { ...proof, reportHash: 'invalid' }),
        /SHA-256/,
      );
      const selected = second.selectSqliteForValidation(verified.revision, proof);
      assert.throws(
        () => journal.returnToLegacy(selected.revision, { ...proof, sourceFingerprint: 'e'.repeat(64) }),
        /Legacy source changed/,
      );
      assert.throws(
        () => journal.returnToLegacy(selected.revision, { ...proof, sourceIdentity: 'e'.repeat(64) }),
        /Legacy source changed/,
      );
      assert.throws(() => journal.returnToLegacy(verified.revision, proof), /Stale/);
      assert.deepEqual(second.read(), selected);
    } finally {
      second.close();
    }
  });
});

test('aborting before SQLite selection keeps legacy selected; retry requires a new generation', async () => {
  await fixture(async (journal) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    const returned = journal.returnToLegacy(verified.revision, proof);
    assert.equal(returned.backend, 'legacy');
    const checked = journal.recordRuntimeValidation(returned.revision, 'legacy', proof.id, 'd'.repeat(64));
    const resumed = journal.resumeWrites(checked.revision, proof);
    assert.throws(() => journal.recordVerifiedCandidate(resumed.revision, proof), /UNIQUE/);
    assert.deepEqual(journal.read(), resumed);
    const retry = journal.recordVerifiedCandidate(resumed.revision, { ...proof, id: 'generation-2' });
    assert.equal(retry.generation?.id, 'generation-2');
    assert.equal(retry.backend, 'legacy');
    assert.equal(retry.paused, true);
  });
});

test('missing, damaged, or unidentified control state fails closed instead of resetting to legacy', async () => {
  await fixture(async (journal, databasePath, root) => {
    const missing = new LocalMetadataTransitionJournal(path.join(root, 'missing.sqlite'));
    await assert.rejects(missing.initialize(), /missing.*refusing to reset/);
    journal.close();
    const raw = new DatabaseSync(databasePath);
    raw.prepare('DELETE FROM transition_state').run();
    raw.close();
    await assert.rejects(new LocalMetadataTransitionJournal(databasePath).initialize(), /selection is missing/);
    await fs.writeFile(path.join(root, 'empty.sqlite'), '');
    await assert.rejects(
      new LocalMetadataTransitionJournal(path.join(root, 'empty.sqlite')).initialize(),
      /identity or schema/,
    );
    await assert.rejects(
      new LocalMetadataTransitionJournal(databasePath).initialize({ create: true }),
      /already exists/,
    );
  });
});

test('read-only verification cannot change transition state', async () => {
  await fixture(async (journal, databasePath) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    journal.close();
    const reader = new LocalMetadataTransitionJournal(databasePath);
    try {
      await reader.initialize({ readOnly: true });
      assert.deepEqual(reader.read(), verified);
      assert.throws(() => reader.selectSqliteForValidation(verified.revision, proof), /read-only/);
      assert.throws(() => reader.returnToLegacy(verified.revision, proof), /read-only/);
    } finally {
      reader.close();
    }
  });
});

test('corrupt proof, unexpected schema objects, or absent validation evidence block restart', async () => {
  for (const corrupt of [
    (db: DatabaseSync) => db.prepare("UPDATE generations SET proof_json = '{}' ").run(),
    (db: DatabaseSync) => db.exec('CREATE TABLE unexpected (value TEXT)'),
    (db: DatabaseSync) => db.exec("UPDATE transition_state SET phase = 'sqlite-live', validation_evidence_hash = NULL"),
  ]) {
    await fixture(async (journal, databasePath) => {
      journal.recordVerifiedCandidate(1, proof);
      journal.close();
      const raw = new DatabaseSync(databasePath);
      corrupt(raw);
      raw.close();
      await assert.rejects(
        new LocalMetadataTransitionJournal(databasePath).initialize(),
        /proof|schema|validation evidence/,
      );
    });
  }
});

test('a process exiting with an uncommitted selection cannot publish a partial switch', async () => {
  await fixture(async (journal, databasePath) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    journal.close();
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(databasePath)});
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
      db.exec("UPDATE transition_state SET phase = 'sqlite-validation', revision = revision + 1");
      process.exit(19);
    `,
      ],
      { stdio: 'pipe' },
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exit, 19, stderr);
    const reopened = new LocalMetadataTransitionJournal(databasePath);
    try {
      await reopened.initialize();
      assert.deepEqual(reopened.read(), verified);
    } finally {
      reopened.close();
    }
  });
});

test('a process exiting immediately after committed selection leaves it paused and reversible', async () => {
  await fixture(async (journal, databasePath) => {
    const verified = journal.recordVerifiedCandidate(1, proof);
    journal.close();
    const moduleUrl = new URL('../local-metadata/transition-journal.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      const { LocalMetadataTransitionJournal } = await import(${JSON.stringify(moduleUrl)});
      const journal = new LocalMetadataTransitionJournal(${JSON.stringify(databasePath)});
      await journal.initialize();
      journal.selectSqliteForValidation(${verified.revision}, ${JSON.stringify(proof)});
      process.exit(23);
    `,
      ],
      { stdio: 'pipe' },
    );
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exit, 23, stderr);
    const reopened = new LocalMetadataTransitionJournal(databasePath);
    try {
      await reopened.initialize();
      const state = reopened.read();
      assert.equal(state.phase, 'sqlite-validation');
      assert.equal(state.paused, true);
      assert.equal(state.canReturnToLegacy, true);
      assert.equal(reopened.returnToLegacy(state.revision, proof).backend, 'legacy');
    } finally {
      reopened.close();
    }
  });
});
