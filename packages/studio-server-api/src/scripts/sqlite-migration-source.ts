import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalMetadataTransitionJournal } from '../local-metadata/transition-journal.js';
import { localMetadataGenerationPaths } from '../local-metadata/serving-selection.js';
import { localMetadataSourceIdentity, type LocalMetadataSourceRoots } from '../local-metadata/source-identity.js';
import { LocalWorkflowCatalog } from '../local-metadata/workflow-catalog.js';
import { SqliteWorkflowBackend } from '../local-metadata/sqlite-workflow-backend.js';
import { SqliteAppSettingsBackend } from '../app-settings/sqlite-settings-store.js';
import { inspectLocalSqliteSnapshot } from '../local-metadata/sqlite-snapshot.js';
import { syncDirectory, writeDurableExclusive } from '../routes/workflows/filesystem-transaction-primitives.js';

async function assertRealDirectories(directories: string[]): Promise<void> {
  for (const directory of directories) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Native migration paths must be real directories.');
  }
}

/** Read the selected live generation, never the retained pre-upgrade files.
 * The importer runs separately from HTTP serving. No database or artifact is
 * rewritten, expanded on disk, or upgraded while taking the source snapshot. */
export class SqliteMigrationSource {
  readonly catalog: LocalWorkflowCatalog;
  readonly workflows: SqliteWorkflowBackend;
  readonly settings: SqliteAppSettingsBackend;
  readonly paths: ReturnType<typeof localMetadataGenerationPaths>;
  readonly #journal: LocalMetadataTransitionJournal;
  readonly #selection: string;
  readonly #roots: LocalMetadataSourceRoots;
  readonly sourceIdentity: string;

  private constructor(controlRoot: string, roots: LocalMetadataSourceRoots, journal: LocalMetadataTransitionJournal) {
    const state = journal.read();
    if (
      state.phase !== 'sqlite-live' ||
      state.backend !== 'sqlite' ||
      !state.generation ||
      !state.validationEvidenceHash
    )
      throw new Error('Native migration requires the validated live SQLite generation.');
    if (state.generation.sourceIdentity !== localMetadataSourceIdentity(roots))
      throw new Error('Native migration source roots differ from the selected generation.');
    this.#journal = journal;
    this.#roots = roots;
    this.#selection = JSON.stringify(state);
    this.paths = localMetadataGenerationPaths(controlRoot, state.generation.id);
    this.sourceIdentity = createHash('sha256')
      .update('sqlite-managed-source-v1\0')
      .update(path.resolve(controlRoot))
      .update('\0')
      .update(state.generation.id)
      .update('\0')
      .update(state.generation.sourceIdentity)
      .digest('hex');
    this.catalog = new LocalWorkflowCatalog({
      databasePath: this.paths.catalogDatabasePath,
      artifactRoot: this.paths.artifactRoot,
    });
    this.workflows = new SqliteWorkflowBackend({
      databasePath: this.paths.catalogDatabasePath,
      artifactRoot: this.paths.artifactRoot,
      virtualRoot: roots.workflows,
      withWrite: async () => {
        throw new Error('Migration source is read-only.');
      },
    });
    this.settings = new SqliteAppSettingsBackend({
      databasePath: this.paths.settingsDatabasePath,
      requireExisting: true,
      convertLegacy: false,
      encryptionSecret: process.env.RIVET_LOCAL_METADATA_ENCRYPTION_KEY,
      previousEncryptionSecret: process.env.RIVET_LOCAL_METADATA_PREVIOUS_ENCRYPTION_KEY,
    });
  }

  static async open(controlRoot: string, roots: LocalMetadataSourceRoots): Promise<SqliteMigrationSource> {
    if (!path.isAbsolute(controlRoot)) throw new Error('Native migration control root must be absolute.');
    const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
    let source: SqliteMigrationSource | undefined;
    try {
      await assertRealDirectories([controlRoot, roots.appData]);
      await journal.initialize({ readOnly: true });
      source = new SqliteMigrationSource(controlRoot, roots, journal);
      await assertRealDirectories([
        path.join(controlRoot, 'generations'),
        source.paths.root,
        source.paths.artifactRoot,
        source.paths.operationalRoot,
      ]);
      await source.assertFrozen();
      source.catalog.initialize({ verifyOnly: true, requireExisting: true });
      source.workflows.initialize({ readOnly: true });
      await source.settings.initialize({ readOnly: true });
      return source;
    } catch (error) {
      if (source) await source.dispose();
      else journal.close();
      throw error;
    }
  }

  /** Operator-only barrier creation, after stopping BOTH serving processes.
   * Never treat an acknowledgement as draining an online source ourselves. */
  static async freeze(controlRoot: string, roots: LocalMetadataSourceRoots): Promise<void> {
    if (process.env.RIVET_MIGRATION_SOURCE_QUIESCED !== '1' || process.env.RIVET_MIGRATION_SOURCE_STOPPED !== '1')
      throw new Error(
        'Stop both source API/executor processes and acknowledge SOURCE_STOPPED and SOURCE_QUIESCED before freezing.',
      );
    if (!path.isAbsolute(controlRoot)) throw new Error('Native migration control root must be absolute.');
    const journal = new LocalMetadataTransitionJournal(path.join(controlRoot, 'transition.sqlite'));
    try {
      await assertRealDirectories([controlRoot, roots.appData]);
      await journal.initialize({ readOnly: true });
      const source = new SqliteMigrationSource(controlRoot, roots, journal);
      await assertRealDirectories([
        path.join(controlRoot, 'generations'),
        source.paths.root,
        source.paths.artifactRoot,
        source.paths.operationalRoot,
      ]);
      const marker = path.join(roots.appData, 'vm-migration-maintenance.json');
      try {
        await writeDurableExclusive(marker, JSON.stringify({ version: 1, enteredAt: new Date().toISOString() }), 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await syncDirectory(roots.appData);
      await source.assertFrozen();
    } finally {
      journal.close();
    }
  }

  async assertFrozen(): Promise<void> {
    if (process.env.RIVET_MIGRATION_SOURCE_QUIESCED !== '1' || process.env.RIVET_MIGRATION_SOURCE_STOPPED !== '1')
      throw new Error(
        'Stop BOTH source processes and acknowledge SOURCE_STOPPED and SOURCE_QUIESCED before native migration.',
      );
    if (JSON.stringify(this.#journal.read()) !== this.#selection)
      throw new Error('Selected SQLite generation changed during migration.');
    const marker = path.join(this.#roots.appData, 'vm-migration-maintenance.json');
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Native migration requires the durable maintenance barrier.');
    const value = JSON.parse(await fs.readFile(marker, 'utf8')) as { version?: unknown; enteredAt?: unknown };
    if (value.version !== 1 || typeof value.enteredAt !== 'string' || !Number.isFinite(Date.parse(value.enteredAt)))
      throw new Error('Native migration maintenance barrier is invalid.');
  }

  async projectHeaders() {
    return (await this.catalog.readTreeProjection()).projects;
  }

  async *projects() {
    for (const relativePath of this.catalog.listProjectPaths()) {
      const project = await this.catalog.readProject(relativePath);
      if (!project) throw new Error('SQLite project disappeared during migration.');
      yield project;
    }
  }

  async manifest(): Promise<Record<string, string>> {
    await this.assertFrozen();
    const parts: Record<string, string> = { selection: createHash('sha256').update(this.#selection).digest('hex') };
    for (const [label, file] of [
      ['workflows', this.paths.catalogDatabasePath],
      ['settings', this.paths.settingsDatabasePath],
      ...['evaluation-runs.sqlite', 'llm-profile-health.sqlite', 'scheduled-runs.sqlite'].map((name) => [
        name,
        path.join(this.paths.operationalRoot, name),
      ]),
    ]) {
      try {
        parts[label!] = (await inspectLocalSqliteSnapshot(file!)).logicalHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || label === 'workflows' || label === 'settings')
          throw error;
        parts[label!] = createHash('sha256').update('absent').digest('hex');
      }
    }
    // Runtime pointers and expected artifact hashes are part of the catalog.
    parts['runtime-libraries'] = parts.workflows!;
    await this.assertFrozen();
    return parts;
  }

  async dispose(): Promise<void> {
    this.workflows.close();
    this.catalog.close();
    this.#journal.close();
    await this.settings.dispose();
  }
}
