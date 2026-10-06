import { lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';
import type { LocalMetadataSourceRoots } from './source-identity.js';
import type { LocalMetadataCandidateReport } from './stage-local-metadata-candidate.js';
import {
  LOCAL_UPGRADE_FAILURE_REASONS,
  type LocalUpgradeFailureReason,
} from '../../../studio-server-shared/local-upgrade-types.js';
import {
  LOCAL_UPGRADE_STAGES,
  LOCAL_UPGRADE_FAILURE_CODES,
  type LocalUpgradeStage,
  type LocalUpgradeFailure,
} from './upgrade-diagnostics.js';

export type LocalUpgradeJob = {
  id: string;
  phase: 'copying' | 'verified' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  sourceFingerprint?: string;
  backupReference?: string;
  stage?: LocalUpgradeStage;
  failure?: LocalUpgradeFailure | null;
};
export type LocalUpgradeCertificate = {
  version: 1;
  generationId: string;
  source: LocalMetadataSourceRoots;
  backupReference: string;
  backupConfirmedAt: string;
  /** Present only on certificates created by encrypted-storage releases. */
  encryptionKeyId?: string;
  /** Empty first-run initialization, not a certificate of a restored backup. */
  origin?: 'empty-installation';
  report: LocalMetadataCandidateReport;
  operational: Record<string, string | null>;
};
const APP_ID = 0x52495550;
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z
  .object({
    id: identifier,
    phase: z.enum(['copying', 'verified', 'failed', 'interrupted']),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    message: z.string().max(1024).nullable(),
    sourceFingerprint: digest.optional(),
    backupReference: z.string().min(1).max(512).optional(),
    stage: z.enum(LOCAL_UPGRADE_STAGES).optional(),
    failure: z
      .object({
        stage: z.enum(LOCAL_UPGRADE_STAGES),
        code: z.enum(LOCAL_UPGRADE_FAILURE_CODES),
        reason: z
          .enum(
            Object.keys(LOCAL_UPGRADE_FAILURE_REASONS) as [LocalUpgradeFailureReason, ...LocalUpgradeFailureReason[]],
          )
          .optional(),
        sourceReference: z
          .string()
          .regex(/^[a-f0-9]{16}$/)
          .optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const certificateSchema = z
  .object({
    version: z.literal(1),
    generationId: identifier,
    source: z
      .object({ workflows: z.string(), recordings: z.string(), appData: z.string(), runtimeLibraries: z.string() })
      .strict()
      .refine((value) => Object.values(value).every(path.isAbsolute)),
    backupReference: z.string().min(1).max(512),
    backupConfirmedAt: z.string().datetime(),
    encryptionKeyId: digest.optional(),
    origin: z.literal('empty-installation').optional(),
    report: z
      .object({
        reportVersion: z.literal(1),
        activationReady: z.literal(false),
        sourceIdentity: digest,
        sourceFingerprint: digest,
        folders: z.number().int().nonnegative(),
        projects: z.number().int().nonnegative(),
        publishedVersions: z.number().int().nonnegative(),
        publishedWebApps: z.number().int().nonnegative(),
        recordings: z.number().int().nonnegative(),
        appSettingsDomains: z.number().int().nonnegative(),
        runtimeLibraryPackages: z.number().int().nonnegative(),
        servingChecks: z
          .object({
            projects: z.number().int().nonnegative(),
            endpoints: z.number().int().nonnegative(),
            webApps: z.number().int().nonnegative(),
            publishedVersions: z.number().int().nonnegative(),
            recordings: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    operational: z
      .object({
        'evaluation-runs.sqlite': digest.nullable(),
        'llm-profile-health.sqlite': digest.nullable(),
        'scheduled-runs.sqlite': digest.nullable().optional(),
      })
      .strict(),
  })
  .strict();
const schema = [
  'CREATE TABLE jobs (id TEXT PRIMARY KEY NOT NULL, job_json TEXT NOT NULL)',
  'CREATE TABLE certificates (generation_id TEXT PRIMARY KEY NOT NULL, certificate_json TEXT NOT NULL)',
];

/** Separate from both authority databases: failed candidates cannot erase the
 * job or recovery evidence. Secrets are never stored in this ledger. */
export class LocalUpgradeOperatorStore {
  #db: DatabaseSync | null = null;
  constructor(readonly controlRoot: string) {}
  async initialize(options: { create?: boolean; readOnly?: boolean } = {}): Promise<void> {
    const file = path.join(this.controlRoot, 'upgrade.sqlite');
    const parent = lstatSync(this.controlRoot);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid local control directory.');
    let created = false;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid local upgrade ledger.');
      if (options.create) throw new Error('Local upgrade ledger already exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!options.create || options.readOnly) throw new Error('Local upgrade ledger is missing.');
      await writeDurableExclusive(file, Buffer.alloc(0), 0o600);
      created = true;
    }
    const db = new DatabaseSync(file, { readOnly: options.readOnly ?? false });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      if (created) {
        db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
        try {
          for (const sql of schema) db.exec(sql);
          db.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 1; COMMIT`);
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        await syncDirectory(this.controlRoot);
      }
      const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Array<{
        sql: string;
      }>;
      const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();
      if (
        db.prepare('PRAGMA application_id').get()?.application_id !== APP_ID ||
        db.prepare('PRAGMA user_version').get()?.user_version !== 1 ||
        actual.length !== schema.length ||
        !schema.every((sql) => actual.some((row) => normalized(row.sql) === normalized(sql))) ||
        db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok'
      )
        throw new Error('Local upgrade ledger is incompatible or damaged.');
      if (!options.readOnly) db.exec('PRAGMA synchronous = FULL');
      this.#db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  close(): void {
    this.#db?.close();
    this.#db = null;
  }
  #database(): DatabaseSync {
    if (!this.#db) throw new Error('Local upgrade ledger is not open.');
    return this.#db;
  }
  latestJob(): LocalUpgradeJob | null {
    const row = this.#database().prepare('SELECT job_json FROM jobs ORDER BY rowid DESC LIMIT 1').get() as
      | { job_json: string }
      | undefined;
    return row ? jobSchema.parse(JSON.parse(row.job_json)) : null;
  }
  saveJob(job: LocalUpgradeJob): void {
    jobSchema.parse(job);
    this.#database()
      .prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET job_json = excluded.job_json')
      .run(job.id, JSON.stringify(job));
  }
  saveCertificate(certificate: LocalUpgradeCertificate): void {
    certificateSchema.parse(certificate);
    const existing = this.#database()
      .prepare('SELECT certificate_json FROM certificates WHERE generation_id = ?')
      .get(certificate.generationId) as { certificate_json: string } | undefined;
    if (existing) {
      if (existing.certificate_json !== JSON.stringify(certificate))
        throw new Error('Local certificate differs on retry.');
      return;
    }
    this.#database()
      .prepare('INSERT INTO certificates VALUES (?, ?)')
      .run(certificate.generationId, JSON.stringify(certificate));
  }
  certificate(generationId: string): LocalUpgradeCertificate {
    const row = this.#database()
      .prepare('SELECT certificate_json FROM certificates WHERE generation_id = ?')
      .get(generationId) as { certificate_json: string } | undefined;
    if (!row) throw new Error('Selected local generation has no verification certificate.');
    const value = certificateSchema.parse(JSON.parse(row.certificate_json)) as LocalUpgradeCertificate;
    if (value.version !== 1 || value.generationId !== generationId || !value.report || !value.source)
      throw new Error('Invalid local verification certificate.');
    return value;
  }
  hasCertificate(generationId: string): boolean {
    return !!this.#database().prepare('SELECT 1 FROM certificates WHERE generation_id = ?').get(generationId);
  }
}
