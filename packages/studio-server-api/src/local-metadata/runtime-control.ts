import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppDataRoot, getWorkflowRecordingsRoot, getWorkflowsRoot } from '../security.js';
import { isVmMigrationMaintenanceActive } from '../vm-migration-maintenance.js';
import { fingerprintVmMigrationSource } from '../scripts/vm-migration-source-manifest.js';
import { inspectLocalSqliteSnapshot } from './sqlite-snapshot.js';
import { LocalMetadataTransitionJournal, type LocalMetadataGenerationProof } from './transition-journal.js';
import { LocalUpgradeOperatorStore, type LocalUpgradeCertificate } from './operator-store.js';
import { localMetadataSourceIdentity, type LocalMetadataSourceRoots } from './source-identity.js';
import { installLocalMetadataServingSelection, localMetadataGenerationPaths } from './serving-selection.js';
export { assertLocalMetadataWritesAllowed } from './write-admission.js';

export const hashLocalUpgradeValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function localMetadataControlRoot(): string {
  const value = process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT?.trim();
  if (!value || !path.isAbsolute(value))
    throw new Error('An absolute persistent local metadata control root is required.');
  return path.resolve(value);
}
export function localMetadataSourceRoots(): LocalMetadataSourceRoots {
  const root = process.env.RIVET_RUNTIME_LIBRARIES_ROOT?.trim();
  if (!root || !path.isAbsolute(root)) throw new Error('An explicit runtime-library source root is required.');
  return {
    workflows: getWorkflowsRoot(),
    recordings: getWorkflowRecordingsRoot(),
    appData: getAppDataRoot(),
    runtimeLibraries: root,
  };
}
export async function assertLocalControlPaths(controlRoot: string, source: LocalMetadataSourceRoots): Promise<void> {
  for (const root of [controlRoot, ...Object.values(source)]) {
    if (!path.isAbsolute(root)) throw new Error('Local upgrade needs absolute source and control paths.');
    let cursor = root;
    while (true) {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Local upgrade roots must have real directory ancestors.');
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  const inside = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  for (const root of Object.values(source))
    if (inside(root, controlRoot) || inside(controlRoot, root))
      throw new Error('Control state must be outside all retained source roots.');
}

/** Called only by explicit offline provisioning, not by serving startup. A
 * missing journal after opt-in is a hard error, never a fresh legacy install. */
export async function provisionLocalMetadataControl(
  controlRoot: string,
  source: LocalMetadataSourceRoots,
): Promise<void> {
  await assertLocalControlPaths(controlRoot, source);
  const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
  const store = new LocalUpgradeOperatorStore(controlRoot);
  try {
    await journal.initialize({ create: true });
    await store.initialize({ create: true });
  } finally {
    store.close();
    journal.close();
  }
}

export async function withLocalMetadataControl<T>(
  operation: (journal: LocalMetadataTransitionJournal, store: LocalUpgradeOperatorStore) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const root = localMetadataControlRoot();
  const journal = new LocalMetadataTransitionJournal(path.join(root, 'transition.sqlite'));
  const store = new LocalUpgradeOperatorStore(root);
  try {
    await journal.initialize({ readOnly });
    await store.initialize({ readOnly });
    return await operation(journal, store);
  } finally {
    store.close();
    journal.close();
  }
}

export async function localCandidateFingerprint(controlRoot: string, generationId: string): Promise<string> {
  const paths = localMetadataGenerationPaths(controlRoot, generationId);
  await assertLocalGenerationDirectories(paths);
  const hashes: Array<[string, string]> = [];
  for (const name of ['catalog.sqlite', 'settings.sqlite'])
    hashes.push([name, (await inspectLocalSqliteSnapshot(path.join(paths.root, name))).logicalHash]);
  for (const name of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite', 'scheduled-runs.sqlite']) {
    const file = path.join(paths.operationalRoot, name);
    try {
      hashes.push([name, (await inspectLocalSqliteSnapshot(file)).logicalHash]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (name !== 'scheduled-runs.sqlite') hashes.push([name, 'absent']);
    }
  }
  const hash = createHash('sha256');
  const walk = async (directory: string, relative = ''): Promise<void> => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate artifact directory is invalid.');
    hash.update(`directory\0${relative}\0`);
    for (const entry of (await fs.readdir(directory)).sort()) {
      const file = path.join(directory, entry),
        name = path.posix.join(relative, entry),
        before = await fs.lstat(file);
      if (before.isSymbolicLink()) throw new Error('Candidate artifact contains a symlink.');
      if (before.isDirectory()) {
        await walk(file, name);
        continue;
      }
      if (!before.isFile()) throw new Error('Candidate artifact is not regular.');
      hash.update(`file\0${name}\0${before.size}\0`);
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const after = await fs.lstat(file);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
        throw new Error('Candidate artifact changed during verification.');
    }
  };
  await walk(paths.artifactRoot);
  return hashLocalUpgradeValue({ databases: hashes, objects: hash.digest('hex') });
}
async function assertLocalGenerationDirectories(paths: ReturnType<typeof localMetadataGenerationPaths>): Promise<void> {
  for (const directory of [paths.root, paths.artifactRoot, paths.operationalRoot]) {
    let cursor = directory;
    while (true) {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Selected generation must have real directory ancestors.');
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  // This direct child is disposable and is not part of the candidate proof.
  // Startup recreates it from the SQL archive, but never follows a replacement
  // symlink or accepts a non-directory at its cache path.
  try {
    const cache = await fs.lstat(paths.runtimeCacheRoot);
    if (!cache.isDirectory() || cache.isSymbolicLink())
      throw new Error('Selected runtime-library cache must be a real directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export function assertLocalGenerationCertificate(
  certificate: LocalUpgradeCertificate,
  proof: LocalMetadataGenerationProof,
  source: LocalMetadataSourceRoots,
): void {
  if (
    hashLocalUpgradeValue(certificate) !== proof.reportHash ||
    localMetadataSourceIdentity(source) !== proof.sourceIdentity
  )
    throw new Error('Local generation certificate or source mount identity differs.');
}
export async function freshLocalGenerationProof(
  certificate: LocalUpgradeCertificate,
): Promise<LocalMetadataGenerationProof> {
  return {
    id: certificate.generationId,
    sourceIdentity: localMetadataSourceIdentity(certificate.source),
    sourceFingerprint: await fingerprintVmMigrationSource(certificate.source),
    candidateIdentity: hashLocalUpgradeValue(
      localMetadataGenerationPaths(localMetadataControlRoot(), certificate.generationId),
    ),
    candidateFingerprint: await localCandidateFingerprint(localMetadataControlRoot(), certificate.generationId),
    reportHash: hashLocalUpgradeValue(certificate),
  };
}

export async function initializeLocalMetadataServing(): Promise<void> {
  if (!process.env.RIVET_LOCAL_METADATA_CONTROL_ROOT) return;
  if (process.env.RIVET_LOCAL_METADATA_SUPERVISED !== '1' || process.env.RIVET_DEPLOYMENT_TOPOLOGY === 'replicated')
    throw new Error('Local SQLite requires the single-host combined supervisor.');
  const source = localMetadataSourceRoots();
  await assertLocalControlPaths(localMetadataControlRoot(), source);
  await withLocalMetadataControl(async (journal, store) => {
    const state = journal.read();
    if (state.revision !== Number(process.env.RIVET_LOCAL_METADATA_BOOT_REVISION))
      throw new Error('Supervised startup revision differs from the transition journal.');
    const bootId = process.env.RIVET_LOCAL_METADATA_BOOT_GENERATION || '';
    if (bootId !== (state.backend === 'sqlite' ? state.generation!.id : ''))
      throw new Error('API and executor startup selection differs from the transition journal.');
    const certificate = state.generation ? store.certificate(state.generation.id) : null;
    if (certificate) assertLocalGenerationCertificate(certificate, state.generation!, source);
    if (state.paused && !isVmMigrationMaintenanceActive())
      throw new Error('Paused selection has lost its durable maintenance fence.');
    if (state.backend !== 'sqlite') {
      // Check recovery before file-backed repositories can create defaults or
      // reconcile anything. Do not consult the damaged candidate or its key.
      // After legacy resumption, legitimate new writes need not match the old
      // frozen content proof, but the original mount identity still applies.
      if (
        state.paused &&
        state.generation &&
        (await fingerprintVmMigrationSource(source)) !== state.generation.sourceFingerprint
      )
        throw new Error('Retained legacy source differs from its certified snapshot; startup is blocked.');
      return;
    }
    if (!certificate) throw new Error('Selected SQLite generation has no certificate.');
    await assertLocalGenerationDirectories(
      localMetadataGenerationPaths(localMetadataControlRoot(), state.generation!.id),
    );
    if (certificate.encryptionKeyId) {
      const settings = new DatabaseSync(
        localMetadataGenerationPaths(localMetadataControlRoot(), certificate.generationId).settingsDatabasePath,
        { readOnly: true },
      );
      try {
        const version = settings.prepare('PRAGMA user_version').get() as { user_version: number };
        if (
          version.user_version === 1 &&
          certificate.encryptionKeyId !== hashLocalUpgradeValue(process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY || '')
        )
          throw new Error('Legacy encrypted settings require the original key for plaintext conversion.');
      } finally {
        settings.close();
      }
    }
    if (state.phase === 'sqlite-validation') {
      const fresh = await freshLocalGenerationProof(certificate);
      if (
        Object.entries(state.generation!).some(
          ([key, value]) => fresh[key as keyof LocalMetadataGenerationProof] !== value,
        )
      )
        throw new Error('Paused local source or candidate changed; startup is blocked.');
    }
    installLocalMetadataServingSelection({
      ...localMetadataGenerationPaths(localMetadataControlRoot(), certificate.generationId),
      generationId: certificate.generationId,
      source: certificate.source,
    });
  }, true);
}
