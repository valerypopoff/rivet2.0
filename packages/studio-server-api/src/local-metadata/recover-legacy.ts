import fs from 'node:fs/promises';
import path from 'node:path';

import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';
import { localMetadataSourceIdentity, type LocalMetadataSourceRoots } from './source-identity.js';
import { LocalMetadataTransitionJournal, type LocalMetadataTransition } from './transition-journal.js';

export async function inspectLocalMetadataTransition(options: {
  controlRoot: string;
  withExclusiveOwner: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<LocalMetadataTransition> {
  const { controlRoot, withExclusiveOwner } = options;
  if (!path.isAbsolute(controlRoot)) throw new Error('Recovery requires an absolute control path.');
  return withExclusiveOwner(async () => {
    const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
    try {
      await journal.initialize({ readOnly: true });
      return journal.read();
    } finally {
      journal.close();
    }
  });
}

/** The caller owns the process-independent combined-backend/converter lease.
 * This reads no candidate database, settings key or package artifact. It only
 * selects legacy while paused; it cannot validate runtime or resume writes. */
export async function recoverLocalMetadataToLegacy(options: {
  controlRoot: string;
  source: LocalMetadataSourceRoots;
  expectedRevision: number;
  expectedGenerationId: string;
  withExclusiveOwner: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<LocalMetadataTransition> {
  const source = { ...options.source };
  const { controlRoot, expectedRevision, expectedGenerationId, withExclusiveOwner } = options;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !expectedGenerationId)
    throw new Error('Recovery requires the expected transition revision and generation.');
  for (const root of [controlRoot, ...Object.values(source)])
    if (!path.isAbsolute(root)) throw new Error('Recovery requires absolute owned paths.');
  for (const root of Object.values(source)) {
    const relative = path.relative(path.resolve(root), path.resolve(controlRoot));
    const inverse = path.relative(path.resolve(controlRoot), path.resolve(root));
    const inside = (value: string) =>
      !value || (!value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value));
    if (inside(relative) || inside(inverse))
      throw new Error('Recovery control state must be outside the retained source roots.');
  }
  return withExclusiveOwner(async () => {
    const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
    try {
      await journal.initialize();
      const state = journal.read();
      if (state.revision !== expectedRevision || state.generation?.id !== expectedGenerationId)
        throw new Error('Stale local recovery request; inspect the current revision and generation.');
      if (!state.canReturnToLegacy)
        throw new Error('One-click rollback is unavailable; use a coordinated restore or reverse migration.');
      const proof = {
        sourceIdentity: localMetadataSourceIdentity(source),
        sourceFingerprint: await fingerprintVmMigrationSource(source),
      };
      if (
        state.generation.sourceIdentity !== proof.sourceIdentity ||
        state.generation.sourceFingerprint !== proof.sourceFingerprint
      )
        throw new Error('Retained legacy source differs from the verified generation; recovery is blocked.');
      const marker = path.join(source.appData, 'vm-migration-maintenance.json');
      try {
        const stat = await fs.lstat(marker);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid retained-source maintenance fence.');
        const value = JSON.parse(await fs.readFile(marker, 'utf8')) as { version: number; enteredAt: string };
        if (value.version !== 1 || typeof value.enteredAt !== 'string' || !Number.isFinite(Date.parse(value.enteredAt)))
          throw new Error('Invalid retained-source maintenance fence.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeDurableExclusive(marker, JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }), 0o600);
      }
      await syncDirectory(source.appData);
      // Host edits are outside the lease. Recheck after durable fencing and
      // before choosing the legacy authority; no candidate/key is consulted.
      if ((await fingerprintVmMigrationSource(source)) !== proof.sourceFingerprint)
        throw new Error('Retained legacy source changed during recovery; writes remain paused.');
      return journal.returnToLegacy(expectedRevision, proof);
    } finally {
      journal.close();
    }
  });
}
