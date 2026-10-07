import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  LOCAL_UPGRADE_PREPARATION_KINDS,
  LOCAL_UPGRADE_FAILURE_REASONS,
  type LocalUpgradePreparation,
} from '../../../studio-server-shared/local-upgrade-types.js';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';
import { createHttpError } from '../utils/httpError.js';
import { duplicateRepairAnalysisSchema } from './duplicate-project-repair.js';
import { localUpgradeFailure } from './upgrade-diagnostics.js';

export class LocalUpgradeDrainTimeoutError extends Error {
  constructor() {
    super(
      'Timed out waiting for active work to drain. Writes remain paused; wait for the source to become quiet, then choose Create verified backup.',
    );
  }
}

/** Wait inside the accepted worker, not its HTTP admission request. A quiet
 * snapshot is usable only while the same transition and maintenance still own it. */
export async function waitForLocalUpgradeDrain(
  readDrain: () => Promise<{ ready: boolean }>,
  assertCurrent: () => Promise<void>,
  timeoutMs = 5 * 60_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    await assertCurrent();
    if (performance.now() >= deadline) throw new LocalUpgradeDrainTimeoutError();
    const drain = await readDrain();
    await assertCurrent();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new LocalUpgradeDrainTimeoutError();
    if (drain.ready) return;
    await delay(Math.min(250, remaining));
  }
}

const count = z.number().int().nonnegative();
const schema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(LOCAL_UPGRADE_PREPARATION_KINDS),
    revision: z.number().int().positive(),
    phase: z.enum(['running', 'ready', 'failed', 'interrupted']),
    stage: z.enum(['inspect', 'pause', 'fingerprint', 'backup', 'repair']),
    inventory: z
      .object({
        source: z.record(z.string(), z.string()),
        capacity: z
          .object({
            payloadBytes: count,
            freeBytes: count,
            requiredBytes: count,
            maxPayloadBytes: count,
            fits: z.boolean(),
            estimatedWorkingBytes: count.optional(),
            memoryBudgetBytes: count.optional(),
            measurementComplete: z.boolean().optional(),
            reasons: z.array(z.string()).optional(),
          })
          .optional(),
        inventory: z
          .object({
            projects: count,
            folders: count,
            recordingBundles: count,
            publishedEndpoints: count,
            publishedVersions: count,
            publishedWebApps: count,
            warnings: z.array(z.string()),
          })
          .nullable(),
        backupRequired: z.string(),
      })
      .optional(),
    fingerprint: z.object({ pausedAt: z.string(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
    error: z.string().max(512).optional(),
    requestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    repairAnalysis: duplicateRepairAnalysisSchema.optional(),
    failure: z
      .object({
        reason: z
          .enum(
            Object.keys(LOCAL_UPGRADE_FAILURE_REASONS) as [
              keyof typeof LOCAL_UPGRADE_FAILURE_REASONS,
              ...(keyof typeof LOCAL_UPGRADE_FAILURE_REASONS)[],
            ],
          )
          .optional(),
        sourceReference: z
          .string()
          .regex(/^[a-f0-9]{16}$/)
          .optional(),
        code: z.string().max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
const failure =
  'Local storage preparation failed. Check source integrity and available space; reload status before retrying. Writes may remain paused.';
const maxBytes = 1024 * 1024;

/** One retained result in private control storage. Never stores raw exceptions,
 * never resumes a worker after restart, and never changes storage authority. */
export class LocalUpgradePreparationJobs {
  #worker: Promise<void> | null = null;
  #starting = false;
  #id: string | null = null;
  #admittingId: string | null = null;
  #activityRevision = 0;
  #stage: LocalUpgradePreparation['stage'] | null = null;
  constructor(readonly root: string) {}
  get running() {
    return this.#starting || this.#worker !== null;
  }
  get stage() {
    return this.#stage;
  }
  async status(): Promise<LocalUpgradePreparation | null> {
    // Bind the file read to the worker snapshot. Completion/admission can cross
    // an asynchronous read; an older running record is not proof of a crash.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = this.#activityRevision;
      const liveId = this.#worker ? this.#id : this.#admittingId;
      const job = await this.#read();
      if (revision !== this.#activityRevision) continue;
      return job?.phase === 'running' && job.id !== liveId
        ? {
            ...job,
            phase: 'interrupted',
            error:
              'Preparation stopped before retaining a completed result. Review current status and retry explicitly.',
          }
        : job;
    }
    throw new Error('Preparation activity changed during status reads.');
  }
  async #read(): Promise<LocalUpgradePreparation | null> {
    const file = path.join(this.root, 'preparation.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
        throw new Error('Invalid preparation record.');
      // Bound reads even if the record grows after lstat.
      const handle = await fs.open(file, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!read.bytesRead) break;
          bytesRead += read.bytesRead;
        }
        if (bytesRead > maxBytes) throw new Error('Preparation record is too large.');
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
      return schema.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async #save(job: LocalUpgradePreparation) {
    const text = JSON.stringify(schema.parse(job));
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Preparation result is too large.');
    const temporary = path.join(this.root, `preparation-${randomUUID()}.tmp`);
    try {
      await writeDurableExclusive(temporary, text, 0o600);
      await fs.rename(temporary, path.join(this.root, 'preparation.json'));
      await syncDirectory(this.root);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async start(
    input: Pick<LocalUpgradePreparation, 'id' | 'kind' | 'revision' | 'requestHash'>,
    work: (
      job: LocalUpgradePreparation,
      stage: (value: LocalUpgradePreparation['stage']) => Promise<void>,
    ) => Promise<void>,
  ): Promise<LocalUpgradePreparation> {
    if (this.#starting)
      throw createHttpError(409, 'Preparation admission is busy. Reload status.', { code: 'local-upgrade-busy' });
    this.#starting = true;
    try {
      const previous = await this.status();
      if (previous?.id === input.id) {
        if (
          previous.kind !== input.kind ||
          previous.revision !== input.revision ||
          previous.requestHash !== input.requestHash
        )
          throw createHttpError(409, 'Preparation request identity differs.');
        return previous;
      }
      if (this.#worker) throw createHttpError(409, 'Preparation is already running.', { code: 'local-upgrade-busy' });
      const job: LocalUpgradePreparation = {
        ...input,
        phase: 'running',
        stage:
          input.kind === 'pause-backup' || input.kind === 'repair-inspect'
            ? 'inspect'
            : input.kind === 'repair-recover'
              ? 'repair'
              : input.kind,
      };
      this.#id = job.id;
      this.#admittingId = job.id;
      this.#activityRevision++;
      try {
        await this.#save(job);
      } catch (error) {
        this.#id = null;
        this.#admittingId = null;
        this.#activityRevision++;
        throw error;
      }
      this.#stage = job.stage;
      this.#worker = new Promise<void>((resolve) => setImmediate(resolve))
        .then(async () => {
          try {
            await work(job, async (value) => {
              job.stage = value;
              this.#stage = value;
              await this.#save(job);
            });
            job.phase = 'ready';
            await this.#save(job);
          } catch (error) {
            job.phase = 'failed';
            job.error = error instanceof LocalUpgradeDrainTimeoutError ? error.message : failure;
            const diagnostic = localUpgradeFailure('preflight', error);
            job.failure = {
              code: diagnostic.code,
              reason: diagnostic.reason,
              sourceReference: diagnostic.sourceReference,
            };
            delete job.fingerprint;
            // A large informational result must not prevent retaining failure.
            if (Buffer.byteLength(JSON.stringify(job)) > maxBytes) delete job.inventory;
            await this.#save(job);
          }
        })
        .catch(() => {
          // Storage errors must not leak raw exceptions or restart the work.
          // A retained running record becomes interrupted once the worker exits.
        })
        .finally(() => {
          this.#worker = null;
          this.#stage = null;
          this.#activityRevision++;
        });
      this.#admittingId = null;
      return { ...job };
    } finally {
      this.#starting = false;
    }
  }
  async settled() {
    await this.#worker;
  }
}
