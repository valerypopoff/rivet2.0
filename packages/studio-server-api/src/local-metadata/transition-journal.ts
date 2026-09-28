import { chmodSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';

export type LocalMetadataGenerationProof = {
  id: string;
  sourceIdentity: string;
  candidateIdentity: string;
  sourceFingerprint: string;
  candidateFingerprint: string;
  reportHash: string;
};

type Phase = 'legacy' | 'verified' | 'sqlite-validation' | 'sqlite-live' | 'legacy-validation' | 'legacy-resumed';
const PHASES: readonly Phase[] = [
  'legacy',
  'verified',
  'sqlite-validation',
  'sqlite-live',
  'legacy-validation',
  'legacy-resumed',
];
export type LocalMetadataTransition = {
  revision: number;
  phase: Phase;
  backend: 'legacy' | 'sqlite';
  paused: boolean;
  canReturnToLegacy: boolean;
  generation: LocalMetadataGenerationProof | null;
  validationEvidenceHash: string | null;
};

type Row = { revision: number; phase: Phase; generation_id: string | null; validation_evidence_hash: string | null };
const APPLICATION_ID = 0x5249544a;
const SCHEMA_VERSION = 1;
const SCHEMA = [
  `CREATE TABLE generations (id TEXT PRIMARY KEY NOT NULL, proof_json TEXT NOT NULL)`,
  `CREATE TABLE transition_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    phase TEXT NOT NULL CHECK (phase IN ('legacy', 'verified', 'sqlite-validation', 'sqlite-live', 'legacy-validation', 'legacy-resumed')),
    generation_id TEXT REFERENCES generations(id),
    validation_evidence_hash TEXT,
    CHECK ((phase = 'legacy' AND generation_id IS NULL) OR (phase != 'legacy' AND generation_id IS NOT NULL)),
    CHECK (validation_evidence_hash IS NULL OR length(validation_evidence_hash) = 64)
  )`,
];

function hash(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Local transition requires a SHA-256 proof.');
}

function validateProof(proof: LocalMetadataGenerationProof): void {
  if (
    !proof ||
    Object.keys(proof).sort().join(',') !==
      'candidateFingerprint,candidateIdentity,id,reportHash,sourceFingerprint,sourceIdentity' ||
    typeof proof.id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(proof.id)
  )
    throw new Error('Invalid local transition generation proof.');
  hash(proof.sourceIdentity);
  hash(proof.candidateIdentity);
  hash(proof.sourceFingerprint);
  hash(proof.candidateFingerprint);
  hash(proof.reportHash);
}

const normalizedSql = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Durable cutover protocol, independent of the candidate databases and keys.
 * It does not select the serving backend. The eventual operator/runtime owner
 * must enforce maintenance, drain and compute fresh proofs before calling it.
 * In particular, do not expose these methods as a partial production switch.
 */
export class LocalMetadataTransitionJournal {
  readonly #databasePath: string;
  #db: DatabaseSync | null = null;
  #readOnly = false;

  constructor(databasePath: string) {
    this.#databasePath = path.resolve(databasePath);
  }

  async initialize(options: { create?: boolean; readOnly?: boolean } = {}): Promise<void> {
    if (this.#db) throw new Error('Local transition journal is already open.');
    if (options.create && options.readOnly) throw new Error('Cannot create a read-only transition journal.');
    const parent = path.dirname(this.#databasePath);
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('Local transition journal requires an existing real persistent directory.');
    }
    let created = false;
    try {
      const stat = lstatSync(this.#databasePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local transition journal must be a regular file.');
      if (options.create) throw new Error('Local transition journal already exists; open it without creating.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.create) throw new Error('Local transition journal is missing; refusing to reset backend selection.');
      await writeDurableExclusive(this.#databasePath, Buffer.alloc(0), 0o600);
      await syncDirectory(parent);
      created = true;
    }
    const db = new DatabaseSync(this.#databasePath, { readOnly: options.readOnly ?? false });
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
      if (created) {
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of SCHEMA) db.exec(statement);
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION}`);
          db.exec("INSERT INTO transition_state VALUES (1, 1, 'legacy', NULL, NULL)");
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        await syncDirectory(parent);
      }
      const identity = db.prepare('PRAGMA application_id').get() as { application_id: number };
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (identity.application_id !== APPLICATION_ID || version.user_version !== SCHEMA_VERSION) {
        throw new Error('Unsupported local transition journal identity or schema.');
      }
      const schema = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string; sql: string }>;
      if (
        schema.length !== SCHEMA.length ||
        !SCHEMA.every((sql) => schema.some((entry) => normalizedSql(entry.sql) === normalizedSql(sql)))
      )
        throw new Error('Local transition journal has an incompatible schema.');
      const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      if (
        integrity.length !== 1 ||
        integrity[0]?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()
      ) {
        throw new Error('Local transition journal failed integrity checks.');
      }
      if (!options.readOnly) db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
      if (!options.readOnly) chmodSync(this.#databasePath, 0o600);
      this.#db = db;
      this.#readOnly = options.readOnly ?? false;
      this.read();
    } catch (error) {
      this.#db = null;
      db.close();
      throw error;
    }
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  #database(): DatabaseSync {
    if (!this.#db) throw new Error('Local transition journal is not open.');
    return this.#db;
  }

  read(): LocalMetadataTransition {
    const db = this.#database();
    const rows = db
      .prepare('SELECT revision, phase, generation_id, validation_evidence_hash FROM transition_state')
      .all() as Row[];
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !PHASES.includes(row.phase)
    ) {
      throw new Error('Local transition selection is missing or invalid.');
    }
    const generations = db.prepare('SELECT id, proof_json FROM generations ORDER BY id').all() as Array<{
      id: string;
      proof_json: string;
    }>;
    let generation: LocalMetadataGenerationProof | null = null;
    for (const stored of generations) {
      const proof = JSON.parse(stored.proof_json) as LocalMetadataGenerationProof;
      validateProof(proof);
      if (proof.id !== stored.id) throw new Error('Local transition generation identity differs from its proof.');
      if (stored.id === row.generation_id) generation = proof;
    }
    if ((row.phase === 'legacy') !== (row.generation_id === null) || (row.generation_id !== null && !generation)) {
      throw new Error('Local transition generation is missing.');
    }
    if (row.validation_evidence_hash !== null) hash(row.validation_evidence_hash);
    if (['legacy', 'verified', 'legacy-resumed'].includes(row.phase) && row.validation_evidence_hash !== null) {
      throw new Error('Local transition has validation evidence in an invalid phase.');
    }
    if (row.phase === 'sqlite-live' && row.validation_evidence_hash === null) {
      throw new Error('Local SQLite writes were enabled without validation evidence.');
    }
    return {
      revision: row.revision,
      phase: row.phase,
      backend: row.phase === 'sqlite-validation' || row.phase === 'sqlite-live' ? 'sqlite' : 'legacy',
      paused: ['verified', 'sqlite-validation', 'legacy-validation'].includes(row.phase),
      canReturnToLegacy: row.phase === 'verified' || row.phase === 'sqlite-validation',
      generation,
      validationEvidenceHash: row.validation_evidence_hash,
    };
  }

  #change(
    expectedRevision: number,
    mutate: (state: LocalMetadataTransition, db: DatabaseSync) => void,
  ): LocalMetadataTransition {
    if (this.#readOnly) throw new Error('Local transition journal is read-only.');
    const db = this.#database();
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      if (state.revision !== expectedRevision) throw new Error('Stale local transition request; reload its state.');
      if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Local transition revision is exhausted.');
      mutate(state, db);
      db.prepare('UPDATE transition_state SET revision = revision + 1 WHERE singleton = 1').run();
      const result = this.read();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  recordVerifiedCandidate(expectedRevision: number, proof: LocalMetadataGenerationProof): LocalMetadataTransition {
    proof = structuredClone(proof);
    validateProof(proof);
    return this.#change(expectedRevision, (state, db) => {
      if (state.phase !== 'legacy' && state.phase !== 'legacy-resumed')
        throw new Error('A local transition is already in progress.');
      db.prepare('INSERT INTO generations (id, proof_json) VALUES (?, ?)').run(proof.id, JSON.stringify(proof));
      db.prepare(
        "UPDATE transition_state SET phase = 'verified', generation_id = ?, validation_evidence_hash = NULL WHERE singleton = 1",
      ).run(proof.id);
    });
  }

  /** Completing a crash gap must fence the process that booted with maintenance
   * still active. Clearing only the marker would reopen its write guards. */
  requireResumedRestart(expectedRevision: number): LocalMetadataTransition {
    return this.#change(expectedRevision, (state) => {
      if (!['sqlite-live', 'legacy-resumed'].includes(state.phase))
        throw new Error('Only durable resumption can require this restart.');
    });
  }

  selectSqliteForValidation(
    expectedRevision: number,
    freshProof: LocalMetadataGenerationProof,
  ): LocalMetadataTransition {
    return this.#change(expectedRevision, (state, db) => {
      if (state.phase !== 'verified') throw new Error('A verified candidate is required before selecting SQLite.');
      validateProof(freshProof);
      if (
        !state.generation ||
        Object.entries(state.generation).some(
          ([key, value]) => freshProof[key as keyof LocalMetadataGenerationProof] !== value,
        )
      ) {
        throw new Error('Local source, candidate or verification report changed; SQLite selection is blocked.');
      }
      db.exec(
        "UPDATE transition_state SET phase = 'sqlite-validation', validation_evidence_hash = NULL WHERE singleton = 1",
      );
    });
  }

  recordRuntimeValidation(
    expectedRevision: number,
    backend: 'legacy' | 'sqlite',
    generationId: string,
    evidenceHash: string,
  ): LocalMetadataTransition {
    hash(evidenceHash);
    return this.#change(expectedRevision, (state, db) => {
      if (state.phase !== `${backend}-validation` || state.generation?.id !== generationId) {
        throw new Error('Runtime validation does not match the selected paused generation.');
      }
      db.prepare('UPDATE transition_state SET validation_evidence_hash = ? WHERE singleton = 1').run(evidenceHash);
    });
  }

  returnToLegacy(
    expectedRevision: number,
    freshSource: Pick<LocalMetadataGenerationProof, 'sourceIdentity' | 'sourceFingerprint'>,
  ): LocalMetadataTransition {
    hash(freshSource.sourceIdentity);
    hash(freshSource.sourceFingerprint);
    return this.#change(expectedRevision, (state, db) => {
      if (!state.canReturnToLegacy)
        throw new Error(
          'One-click rollback is unavailable after SQLite writes are enabled. Use a verified restore or reverse migration.',
        );
      if (
        state.generation?.sourceIdentity !== freshSource.sourceIdentity ||
        state.generation.sourceFingerprint !== freshSource.sourceFingerprint
      )
        throw new Error('Legacy source changed; refusing to resume a different or damaged source.');
      db.exec(
        "UPDATE transition_state SET phase = 'legacy-validation', validation_evidence_hash = NULL WHERE singleton = 1",
      );
    });
  }

  resumeWrites(
    expectedRevision: number,
    freshProof: Pick<LocalMetadataGenerationProof, 'sourceIdentity' | 'sourceFingerprint'> &
      Partial<LocalMetadataGenerationProof>,
  ): LocalMetadataTransition {
    return this.#change(expectedRevision, (state, db) => {
      if (!['sqlite-validation', 'legacy-validation'].includes(state.phase) || !state.validationEvidenceHash) {
        throw new Error('Writes remain paused until the selected runtime has passed validation.');
      }
      hash(freshProof.sourceIdentity);
      hash(freshProof.sourceFingerprint);
      if (
        state.generation?.sourceIdentity !== freshProof.sourceIdentity ||
        state.generation.sourceFingerprint !== freshProof.sourceFingerprint
      )
        throw new Error('Legacy source changed; write resumption is blocked.');
      if (state.backend === 'sqlite') {
        validateProof(freshProof as LocalMetadataGenerationProof);
        if (
          Object.entries(state.generation).some(
            ([key, value]) => freshProof[key as keyof LocalMetadataGenerationProof] !== value,
          )
        )
          throw new Error('Local candidate or verification report changed; write resumption is blocked.');
      }
      // Persist the conservative rollback boundary BEFORE admitting any writes.
      // Even a crash before the first save must never reopen one-click rollback.
      if (state.backend === 'sqlite') db.exec("UPDATE transition_state SET phase = 'sqlite-live' WHERE singleton = 1");
      else
        db.exec(
          "UPDATE transition_state SET phase = 'legacy-resumed', validation_evidence_hash = NULL WHERE singleton = 1",
        );
    });
  }

  /** Fence old processes even when a failed copy is abandoned before a
   * generation exists. The next supervised startup must read this revision. */
  requireLegacyRestart(expectedRevision: number): LocalMetadataTransition {
    return this.#change(expectedRevision, (state) => {
      if (!['legacy', 'legacy-resumed'].includes(state.phase))
        throw new Error('Only unchanged legacy can be resumed without a generation.');
    });
  }
}
