import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FilesystemRivetEvaluationStore } from '../evaluation-runs/filesystem-store.js';
import { FilesystemRivetLLMProfileHealthStore } from '../llm-profile-health/filesystem-store.js';
import { assertEmptyLocalOperationalDatabase } from './operational-schema.js';
import { stageLocalMetadataCandidate } from './stage-local-metadata-candidate.js';
import { LocalMetadataTransitionJournal } from './transition-journal.js';
import { LocalUpgradeOperatorStore, type LocalUpgradeCertificate } from './operator-store.js';
import { assertLocalControlPaths, freshLocalGenerationProof, hashLocalUpgradeValue } from './runtime-control.js';
import { localMetadataGenerationPaths } from './serving-selection.js';
import type { LocalMetadataSourceRoots } from './source-identity.js';
import { inspectLocalSqliteSnapshot } from './sqlite-snapshot.js';

/** Offline, supervisor-owned first start only. Never a migration shortcut:
 * every source entry except the matching installation binding must be absent. */
export async function initializeEmptyLocalInstallation(root: string, source: LocalMetadataSourceRoots): Promise<void> {
  await assertLocalControlPaths(root, source);
  const readPrivateJson = async (file: string) => {
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && stat.mode & 0o077)
    )
      throw new Error('Invalid first-run installation identity.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  };
  const config = await readPrivateJson(path.join(root, 'ui-configuration.json'));
  if (
    config.version !== 2 ||
    config.phase !== 'initializing' ||
    Object.keys(config).sort().join(',') !== 'installationId,phase,version' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.installationId)
  )
    throw new Error('Only an owned, incomplete empty installation may be initialized.');
  const assertEmpty = async () => {
    const binding = await readPrivateJson(path.join(source.appData, 'local-metadata-ui-control.json'));
    if (JSON.stringify(binding) !== JSON.stringify({ version: 2, root, installationId: config.installationId }))
      throw new Error('First-run installation binding differs.');
    for (const [name, directory] of Object.entries(source)) {
      const entries = await fs.readdir(directory);
      if (entries.some((entry) => name !== 'appData' || entry !== 'local-metadata-ui-control.json'))
        throw new Error('Retained source data requires the guided upgrade, not first-run initialization.');
    }
  };
  await assertEmpty();
  const journal = new LocalMetadataTransitionJournal(path.join(root, 'transition.sqlite'));
  const store = new LocalUpgradeOperatorStore(root);
  try {
    const exists = async (file: string) => {
      try {
        await fs.lstat(file);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const journalExists = await exists(path.join(root, 'transition.sqlite'));
    const storeExists = await exists(path.join(root, 'upgrade.sqlite'));
    if (!journalExists && (storeExists || (await exists(path.join(root, 'generations')))))
      throw new Error('First-run journal was lost; refusing to replace selection.');
    await journal.initialize({ create: !journalExists });
    let state = journal.read();
    if (!storeExists && (state.revision !== 1 || state.phase !== 'legacy'))
      throw new Error('First-run certificate ledger was lost.');
    await store.initialize({ create: !storeExists });
    const id = config.installationId;
    if (
      (state.generation && state.generation.id !== id) ||
      !['legacy', 'verified', 'sqlite-validation', 'sqlite-live'].includes(state.phase)
    )
      throw new Error('First-run control has an unrelated transition.');
    const existing = store.hasCertificate(id) ? store.certificate(id) : null;
    if (existing && existing.origin !== 'empty-installation') throw new Error('Not a first-run certificate.');
    if (state.generation && !existing) throw new Error('First-run certificate is missing.');
    const paths = localMetadataGenerationPaths(root, id);
    if (!existing) {
      await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
      await fs.mkdir(paths.operationalRoot, { recursive: true, mode: 0o700 });
    }
    const report = await stageLocalMetadataCandidate({
      source,
      candidate: paths,
      verifyOnly: !!existing,
      assertFrozen: assertEmpty,
    });
    // Registered App Settings defaults are deliberately seeded into SQLite;
    // their count need not be zero even though all legacy roots are empty.
    if (
      [
        report.folders,
        report.projects,
        report.recordings,
        report.runtimeLibraryPackages,
        report.publishedVersions,
        report.publishedWebApps,
      ].some((count) => count !== 0)
    )
      throw new Error('First-run candidate is not empty.');
    const operational: LocalUpgradeCertificate['operational'] = {};
    for (const [name, domain] of [
      ['evaluation-runs.sqlite', 'evaluations'],
      ['llm-profile-health.sqlite', 'health'],
    ] as const) {
      const file = path.join(paths.operationalRoot, name);
      if (!existing) {
        const empty =
          domain === 'evaluations'
            ? new FilesystemRivetEvaluationStore(file)
            : new FilesystemRivetLLMProfileHealthStore(file);
        try {
          if (empty instanceof FilesystemRivetEvaluationStore) await empty.getLibrarySnapshot();
          else await empty.list();
        } finally {
          await empty.dispose();
        }
      }
      const database = new DatabaseSync(file, { readOnly: true });
      try {
        assertEmptyLocalOperationalDatabase(database, domain);
      } finally {
        database.close();
      }
      operational[name] = (await inspectLocalSqliteSnapshot(file)).logicalHash;
    }
    const certificate: LocalUpgradeCertificate = {
      version: 1,
      generationId: id,
      source,
      backupReference: 'empty-installation:no-source-data',
      backupConfirmedAt: existing?.backupConfirmedAt || new Date().toISOString(),
      origin: 'empty-installation',
      report,
      operational,
    };
    await assertEmpty();
    const proof = await freshLocalGenerationProof(certificate);
    store.saveCertificate(certificate);
    if (state.phase === 'legacy') state = journal.recordVerifiedCandidate(state.revision, proof);
    if (state.phase === 'verified') state = journal.selectSqliteForValidation(state.revision, proof);
    if (state.phase === 'sqlite-validation') {
      // No existing data or runtime needs conversion. Serving verification and
      // empty operational schema checks above certify this first-run layout.
      state = journal.recordRuntimeValidation(
        state.revision,
        'sqlite',
        id,
        hashLocalUpgradeValue({ origin: 'empty-installation', proof, serving: report.servingChecks, operational }),
      );
      await assertEmpty();
      state = journal.resumeWrites(state.revision, proof);
    }
    if (state.phase !== 'sqlite-live' || JSON.stringify(state.generation) !== JSON.stringify(proof))
      throw new Error('First-run selection differs from its verified candidate.');
  } finally {
    store.close();
    journal.close();
  }
}
