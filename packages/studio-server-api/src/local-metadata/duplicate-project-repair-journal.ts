// Leaf control-state module: safe to import from synchronous write admission.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';
import { createHttpError } from '../utils/httpError.js';

const name = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const maxBytes = 1024 * 1024;
const schema = z
  .object({
    id: z.string().uuid(),
    phase: z.enum(['applying', 'complete']),
    sourceIdentity: digest,
    revision: z.number().int().positive(),
    pausedAt: name,
    archiveHash: digest,
    assignments: z.array(z.object({ path: name, oldId: name, newId: z.string().uuid() }).strict()).max(10000),
    files: z
      .array(z.object({ path: name, before: digest, after: digest, mode: z.number().int().min(0).max(0o777) }).strict())
      .min(1)
      .max(10000),
  })
  .strict();
export type DuplicateRepairJournal = z.infer<typeof schema>;

/** Bounded independently of the project payload budget. Atomic replacement is
 * the only journal writer; unexpected types, truncation and drift fail closed. */
export function readDuplicateRepairJournal(control: string): DuplicateRepairJournal | null {
  if (!path.isAbsolute(control)) throw new Error('Repair control root must be absolute.');
  let cursor = path.resolve(control);
  for (;;) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe repair control directory.');
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const file = path.join(control, 'duplicate-project-repair.json');
  let descriptor: number;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid repair journal.');
    descriptor = openSync(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Invalid repair journal.');
    const buffer = Buffer.alloc(before.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    const after = fstatSync(descriptor);
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Repair journal changed during read.');
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes))));
  } finally {
    closeSync(descriptor);
  }
}

export async function saveDuplicateRepairJournal(control: string, journal: DuplicateRepairJournal) {
  const contents = JSON.stringify(schema.parse(journal));
  if (Buffer.byteLength(contents) > maxBytes) throw new Error('Repair journal is too large.');
  const temporary = path.join(control, `repair-${randomUUID()}.tmp`);
  try {
    await writeDurableExclusive(temporary, contents, 0o600);
    await fs.rename(temporary, path.join(control, 'duplicate-project-repair.json'));
    await syncDirectory(control);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function assertNoPendingDuplicateRepair(control: string): void {
  if (readDuplicateRepairJournal(control)?.phase === 'applying')
    throw createHttpError(
      409,
      'Finish the interrupted project-ID repair before any other storage action. Writes must remain paused.',
    );
}
