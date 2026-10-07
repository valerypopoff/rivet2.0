import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as tar from 'tar';
import { z } from 'zod';
import {
  canUseNodeAsPrefabSource,
  getNodePrefabInstancePrefabId,
  deserializeProject,
  serializeProject,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type {
  LocalUpgradeDuplicateRepairAnalysis,
  LocalUpgradeDuplicateRepairChoices,
  LocalUpgradeDuplicateRepairStatus,
} from '../../../studio-server-shared/local-upgrade-types.js';
import { localMetadataSourceIdentity, type LocalMetadataSourceRoots } from './source-identity.js';
import { collectSourceFolderPaths } from './filesystem-workflow-source.js';
import { listProjectPathsRecursive } from '../routes/workflows/fs-helpers.js';
import {
  readStoredWorkflowProjectSettings,
  createWorkflowPublicationStateHashFromContents,
} from '../routes/workflows/publication.js';
import { readMigrationSourceUtf8 } from '../scripts/migration-source-utf8.js';
import { withLocalSourceBudget } from './source-budget.js';
import { LocalUpgradeDiagnosticError, localUpgradeSourceError } from './upgrade-diagnostics.js';
import {
  writeDurableExclusive,
  syncDirectory,
  syncFileDescriptor,
} from '../routes/workflows/filesystem-transaction-primitives.js';
import { hashBackupArchive } from './browser-backup.js';
import {
  assertNoPendingDuplicateRepair,
  readDuplicateRepairJournal as readJournal,
  saveDuplicateRepairJournal as saveJournal,
  type DuplicateRepairJournal as Journal,
} from './duplicate-project-repair-journal.js';
export { assertNoPendingDuplicateRepair } from './duplicate-project-repair-journal.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(4096);
const limit = 10000;
export const duplicateRepairChoicesSchema = z
  .object({
    token: digest,
    retainReferences: z.literal(true),
    groups: z
      .array(
        z
          .object({
            projectId: name,
            keeperPath: name,
            historyOwners: z.record(name, name),
          })
          .strict(),
      )
      .min(1)
      .max(limit),
  })
  .strict();
export const duplicateRepairAnalysisSchema = z
  .object({
    token: digest,
    groups: z
      .array(
        z
          .object({
            projectId: name,
            projects: z.array(z.object({ path: name, published: z.boolean() }).strict()).max(limit),
            history: z
              .array(
                z
                  .object({
                    id: name,
                    originalPath: name,
                    suggestedOwner: name.nullable(),
                    activeOwner: name.nullable(),
                  })
                  .strict(),
              )
              .max(limit),
            references: z.array(name).max(limit),
            recordings: z.number().int().nonnegative(),
            operationalRows: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(limit),
    warnings: z.array(name).max(limit),
  })
  .strict();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const repairDirectory = (control: string, id: string) =>
  path.join(control, 'project-id-repairs', z.string().uuid().parse(id));

/** No following symlinks, including ancestors; persisted paths cannot escape the root. */
async function safePath(root: string, relative: string): Promise<string> {
  const segments = relative.split('/');
  if (
    path.isAbsolute(relative) ||
    segments.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  )
    throw new Error('Unsafe repair path.');
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Unsafe repair path.');
  let cursor = target;
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || (cursor !== target && !stat.isDirectory())) throw new Error('Unsafe repair entry.');
    if (cursor === path.parse(cursor).root) break;
    cursor = path.dirname(cursor);
  }
  return target;
}
async function read(root: string, relative: string): Promise<string> {
  return withLocalSourceBudget(() => readMigrationSourceUtf8(path.join(root, relative)));
}
async function optional(root: string, relative: string): Promise<string | null> {
  try {
    await safePath(root, relative);
    return await read(root, relative);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parseProject(text: string) {
  try {
    return deserializeProject(text, null, { logErrors: false });
  } catch (error) {
    throw new LocalUpgradeDiagnosticError('project-parse-failed', undefined, error);
  }
}
function replaceId(text: string, oldId: string, newId: string): string {
  const [project, attached] = parseProject(text);
  if (project.metadata.id !== oldId) throw new Error('Project identity changed.');
  project.metadata.id = newId as ProjectId;
  const result = serializeProject(project, attached);
  if (typeof result !== 'string') throw new Error('Project serializer returned non-text data.');
  // Serialization must preserve every other semantic field and attached data.
  assert.deepStrictEqual(parseProject(result), [project, attached]);
  return result;
}
async function directoryEntries(root: string, relative: string) {
  try {
    const directory = await safePath(root, relative);
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Expected directory.');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink())) throw new Error('Unsafe repair entry.');
    if (entries.length > limit) throw new Error('Repair inventory limit exceeded.');
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Read one bounded document at a time. Library resolution is deliberately not
 * bundle validation: broken prefab links are warnings, not silently dropped calls. */
export async function inspectDuplicateProjectIds(
  source: LocalMetadataSourceRoots,
): Promise<LocalUpgradeDuplicateRepairAnalysis> {
  const root = source.workflows;
  await collectSourceFolderPaths(root);
  const paths = (await listProjectPathsRecursive(root)).sort();
  if (paths.length > limit) throw new Error('Repair inventory limit exceeded.');
  const files = new Map<string, string | null>();
  const byId = new Map<string, LocalUpgradeDuplicateRepairAnalysis['groups'][number]['projects']>();
  const calls = new Map<string, Set<string>>();
  const activeSnapshots = new Map<string, string[]>();
  const projectIds = new Map<string, string>();
  const warnings: string[] = [];
  const discoverCalls = (project: ReturnType<typeof parseProject>[0], owner: string, label = owner) => {
    const addCall = (id: unknown) => {
      if (typeof id !== 'string' || !id) return;
      const references = calls.get(id) ?? new Set<string>();
      references.add(owner);
      calls.set(id, references);
    };
    for (const reference of project.references ?? []) addCall(reference.id);
    const nodes = [
      ...Object.values(project.graphs).flatMap((graph) => graph.nodes),
      ...Object.values(project.nodePrefabs ?? {}).map((prefab) => prefab.sourceNode),
    ];
    let unresolved = false;
    for (const node of nodes) {
      const data = (node.data ?? {}) as { targetProjectId?: string; projectId?: string };
      if (node.type === 'subGraph') addCall(data.targetProjectId);
      if (node.type === 'referencedGraphAlias') addCall(data.projectId);
      if (node.type === 'nodePrefabInstance') {
        const prefabId = getNodePrefabInstancePrefabId(node);
        const sourceNode = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode : undefined;
        if (!sourceNode || !canUseNodeAsPrefabSource(sourceNode)) unresolved = true;
      }
    }
    if (unresolved)
      warnings.push(
        `Unresolved library nodes in ${label}; reference discovery is incomplete. Existing references will not be rewritten.`,
      );
  };
  for (const absolute of paths) {
    const relative = path.relative(root, absolute).replace(/\\/g, '/');
    try {
      await safePath(root, relative);
      const text = await read(root, relative);
      files.set(relative, hash(text));
      const [project] = parseProject(text);
      const id = project.metadata.id?.trim();
      if (!id) throw new LocalUpgradeDiagnosticError('project-id-missing');
      projectIds.set(relative, id);
      const settingsPath = `${relative}.wrapper-settings.json`;
      const settingsText = await optional(root, settingsPath);
      files.set(settingsPath, settingsText === null ? null : hash(settingsText));
      const settings = await readStoredWorkflowProjectSettings(
        absolute,
        path.basename(relative, '.rivet-project'),
        settingsText,
      );
      const list = byId.get(id) ?? [];
      list.push({
        path: relative,
        published:
          !!settings.publishedEndpointName || !!settings.publishedSnapshotId || settings.publishedWebApps.length > 0,
      });
      byId.set(id, list);
      for (const snapshot of [
        settings.publishedSnapshotId,
        ...settings.publishedWebApps.map((app) => app.publishedSnapshotId),
      ]) {
        if (!snapshot) continue;
        const owners = activeSnapshots.get(snapshot) ?? [];
        owners.push(relative);
        activeSnapshots.set(snapshot, owners);
      }
      discoverCalls(project, relative);
    } catch (error) {
      throw localUpgradeSourceError(error, relative, 'unexpected-error');
    }
  }
  // Published callers may differ from their current drafts. Legacy endpoints
  // without a snapshot serve the already-scanned draft; web apps use snapshots.
  for (const [snapshot, owners] of activeSnapshots) {
    const relative = `.published/${snapshot}.rivet-project`;
    try {
      const text = await optional(root, relative);
      files.set(relative, text === null ? null : hash(text));
      if (text === null) {
        warnings.push(`Missing active published snapshot ${snapshot}; reference discovery is incomplete.`);
        continue;
      }
      const [project] = parseProject(text);
      for (const owner of new Set(owners)) {
        if (project.metadata.id !== projectIds.get(owner))
          throw new LocalUpgradeDiagnosticError('publication-owner-mismatch');
        discoverCalls(project, owner, `published snapshot of ${owner}`);
      }
    } catch (error) {
      throw localUpgradeSourceError(error, relative, 'unexpected-error');
    }
  }
  const groups = [...byId]
    .filter(([, projects]) => projects.length > 1)
    .map(([projectId, projects]) => ({
      projectId,
      projects,
      history: [] as LocalUpgradeDuplicateRepairAnalysis['groups'][number]['history'],
      references: [...(calls.get(projectId) ?? [])].sort(),
      recordings: 0,
      operationalRows: 0,
    }));
  const conflicts = new Map(groups.map((group) => [group.projectId, group]));
  for (const entry of await directoryEntries(root, '.published')) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const relative = `.published/${entry.name}`;
    const text = await read(root, relative);
    files.set(relative, hash(text));
    let metadata: { id?: string; projectId?: string; relativePath?: string };
    try {
      metadata = JSON.parse(text);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error('Invalid archive metadata.');
    } catch (error) {
      throw localUpgradeSourceError(error, relative, 'publication-history-invalid');
    }
    const group = conflicts.get(metadata.projectId ?? '');
    if (!group) continue;
    if (
      metadata.id !== entry.name.slice(0, -5) ||
      !/^[a-z0-9_-]{1,128}$/i.test(metadata.id) ||
      typeof metadata.relativePath !== 'string'
    )
      throw new LocalUpgradeDiagnosticError('publication-history-invalid');
    const snapshot = `.published/${metadata.id}.rivet-project`;
    await safePath(root, snapshot);
    const contents = await read(root, snapshot);
    if (parseProject(contents)[0].metadata.id !== group.projectId)
      throw new LocalUpgradeDiagnosticError('publication-owner-mismatch');
    files.set(snapshot, hash(contents));
    const datasetPath = `.published/${metadata.id}.rivet-data`;
    const dataset = await optional(root, datasetPath);
    files.set(datasetPath, dataset === null ? null : hash(dataset));
    const active = [...new Set(activeSnapshots.get(metadata.id) ?? [])];
    if (active.length > 1)
      warnings.push(
        `Published version ${metadata.id} is shared by multiple active projects: ${active.join('; ')}. Unpublish projects receiving new IDs before repairing.`,
      );
    const exact = group.projects.find((project) => project.path === metadata.relativePath);
    const basename = group.projects.filter(
      (project) => path.posix.basename(project.path) === path.posix.basename(metadata.relativePath!),
    );
    group.history.push({
      id: metadata.id,
      originalPath: metadata.relativePath,
      activeOwner: active.length === 1 ? active[0]! : null,
      suggestedOwner: active[0] ?? exact?.path ?? (basename.length === 1 ? basename[0]!.path : null),
    });
  }
  for (const group of groups) {
    // IDs are not assumed to be filesystem-safe; foreign legacy IDs must not
    // become paths merely because they appeared in a project document.
    if (/^[a-z0-9_-]{1,128}$/i.test(group.projectId))
      group.recordings = (await directoryEntries(source.recordings, group.projectId)).filter((entry) =>
        entry.isDirectory(),
      ).length;
    else throw new LocalUpgradeDiagnosticError('project-id-missing');
  }
  for (const databaseName of ['evaluation-runs.sqlite', 'llm-profile-health.sqlite', 'scheduled-runs.sqlite']) {
    let databasePath: string;
    try {
      databasePath = await safePath(source.appData, databaseName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!(await fs.lstat(databasePath)).isFile()) throw new Error('Invalid operational database.');
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout=5000');
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      for (const { name: table } of tables) {
        const supported = [
          'evaluation_runs',
          'evaluation_recordings',
          'evaluation_dataset_snapshots',
          'evaluation_deleted_projects',
          'llm_profile_health',
          'rivet_schedules',
          'rivet_schedule_runs',
        ];
        if (!supported.includes(table)) continue;
        const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
        // Older health stores added the scalar index without backfilling rows.
        // Their retained identities still matter even when project_id is null.
        const healthIdentity = table === 'llm_profile_health' && columns.some((column) => column.name === 'entry_json');
        const scalarId = columns.some((column) => column.name === 'project_id');
        let identity: string;
        if (healthIdentity) {
          const jsonId = "json_extract(entry_json, '$.identity.projectId')";
          identity = scalarId ? `COALESCE(project_id, ${jsonId})` : jsonId;
        } else if (scalarId) identity = 'project_id';
        else if (columns.some((column) => column.name === 'json')) identity = "json_extract(json, '$.projectId')";
        else continue;
        const countRows = database.prepare(`SELECT count(*) AS count FROM "${table}" WHERE ${identity} = ?`);
        for (const group of groups) {
          const row = countRows.get(group.projectId) as { count: number };
          group.operationalRows += Number(row.count);
        }
      }
    } finally {
      database.close();
    }
  }
  // Tokens include all drafts, settings, archive metadata and affected snapshot
  // datasets. Paused repair repeats discovery and refuses a stale preview.
  const token = hash(JSON.stringify({ files: [...files].sort(([a], [b]) => a.localeCompare(b)), groups, warnings }));
  const result = duplicateRepairAnalysisSchema.parse({ token, groups, warnings });
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw new Error('Repair preview is too large.');
  return result;
}

export async function duplicateRepairStatus(control: string): Promise<LocalUpgradeDuplicateRepairStatus | null> {
  const journal = readJournal(control);
  return (
    journal && {
      id: journal.id,
      phase: journal.phase,
      archiveHash: journal.archiveHash,
      changedFiles: journal.files.length,
      assignments: journal.assignments,
    }
  );
}

/** Back up only changed project/history documents. Datasets and recording
 * artifacts are untouched. The ordinary full migration backup is still required. */
export async function repairDuplicateProjectIds(options: {
  control: string;
  source: LocalMetadataSourceRoots;
  revision: number;
  pausedAt: string;
  choices: LocalUpgradeDuplicateRepairChoices;
  assertFrozen: () => Promise<void>;
  checkpoint?: (name: string) => Promise<void>;
}) {
  assertNoPendingDuplicateRepair(options.control);
  await options.assertFrozen();
  const analysis = await inspectDuplicateProjectIds(options.source);
  const choices = duplicateRepairChoicesSchema.parse(options.choices);
  if (analysis.token !== choices.token || choices.groups.length !== analysis.groups.length)
    throw new LocalUpgradeDiagnosticError('repair-preview-stale');
  const changes = new Map<string, { before: string; after: string; mode: number }>();
  let patchBytes = 0;
  const assignments: Journal['assignments'] = [];
  const usedIds = new Set<string>(analysis.groups.map((group) => group.projectId));
  const addChange = async (relative: string, update: (text: string) => string) => {
    if (changes.has(relative)) throw new Error('Conflicting repair ownership.');
    const absolute = await safePath(options.source.workflows, relative);
    const before = await read(options.source.workflows, relative);
    const after = update(before);
    if (after !== before) {
      patchBytes += Buffer.byteLength(before) + Buffer.byteLength(after);
      if (patchBytes > 128 * 1048576) throw new LocalUpgradeDiagnosticError('source-bundle-limit');
      changes.set(relative, { before, after, mode: (await fs.lstat(absolute)).mode & 0o777 });
    }
  };
  const chosenGroups = new Set<string>();
  for (const group of analysis.groups) {
    const choice = choices.groups.find((value) => value.projectId === group.projectId);
    if (
      !choice ||
      chosenGroups.has(choice.projectId) ||
      !group.projects.some((project) => project.path === choice.keeperPath)
    )
      throw new Error('Invalid repair owner.');
    chosenGroups.add(choice.projectId);
    const ids = new Map([[choice.keeperPath, group.projectId]]);
    for (const project of group.projects) {
      if (project.path === choice.keeperPath) continue;
      // Active publications without history cannot be reassigned safely here.
      if (project.published) throw new LocalUpgradeDiagnosticError('repair-publication-active');
      let nextId: string;
      do {
        nextId = randomUUID();
      } while (usedIds.has(nextId));
      usedIds.add(nextId);
      ids.set(project.path, nextId);
      assignments.push({ path: project.path, oldId: group.projectId, newId: nextId });
      await addChange(project.path, (text) => replaceId(text, group.projectId, nextId));
    }
    if (Object.keys(choice.historyOwners).length !== group.history.length)
      throw new Error('Assign every historical publication exactly once.');
    for (const entry of group.history) {
      const owner = choice.historyOwners[entry.id];
      const newId = ids.get(owner ?? '');
      if (!newId || (entry.activeOwner && entry.activeOwner !== owner)) throw new Error('Invalid publication owner.');
      if (newId === group.projectId) continue;
      const snapshot = `.published/${entry.id}.rivet-project`;
      await addChange(snapshot, (text) => replaceId(text, group.projectId, newId));
      const dataset = await optional(options.source.workflows, `.published/${entry.id}.rivet-data`);
      await addChange(`.published/${entry.id}.json`, (text) => {
        const metadata = JSON.parse(text);
        metadata.projectId = newId;
        if (typeof metadata.endpointName !== 'string') throw new Error('Invalid publication history.');
        metadata.stateHash = createWorkflowPublicationStateHashFromContents(
          changes.get(snapshot)!.after,
          dataset,
          metadata.endpointName,
        );
        return `${JSON.stringify(metadata, null, 2)}\n`;
      });
    }
  }
  if (!changes.size) throw new Error('No duplicate identities to repair.');
  await options.assertFrozen();
  const id = randomUUID();
  const parent = path.join(options.control, 'project-id-repairs');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await safePath(options.control, 'project-id-repairs');
  const directory = repairDirectory(options.control, id);
  await fs.mkdir(directory, { mode: 0o700 });
  try {
    await fs.mkdir(path.join(directory, 'before'), { mode: 0o700 });
    await fs.mkdir(path.join(directory, 'after'), { mode: 0o700 });
    const files: Journal['files'] = [];
    for (const [relative, change] of changes) {
      const index = String(files.length);
      await writeDurableExclusive(path.join(directory, 'before', index), change.before, 0o600);
      await writeDurableExclusive(path.join(directory, 'after', index), change.after, 0o600);
      files.push({ path: relative, before: hash(change.before), after: hash(change.after), mode: change.mode });
    }
    await writeDurableExclusive(path.join(directory, 'manifest.json'), JSON.stringify({ files, assignments }), 0o600);
    await syncDirectory(path.join(directory, 'before'));
    await syncDirectory(path.join(directory, 'after'));
    await syncDirectory(directory);
    const archive = path.join(directory, 'repair-backup.tar.gz');
    await tar.c({ cwd: directory, file: archive, gzip: true, portable: true, noMtime: true }, [
      'manifest.json',
      'before',
      'after',
    ]);
    await fs.chmod(archive, 0o600);
    const handle = await fs.open(archive, 'r+');
    try {
      await syncFileDescriptor(handle.fd);
    } finally {
      await handle.close();
    }
    const restored = path.join(directory, 'verified-restore');
    await fs.mkdir(restored, { mode: 0o700 });
    await tar.x({ cwd: restored, file: archive, strict: true });
    assert.equal(await read(restored, 'manifest.json'), await read(directory, 'manifest.json'));
    for (let index = 0; index < files.length; index++) {
      assert.equal(hash(await read(restored, `before/${index}`)), files[index]!.before);
      assert.equal(hash(await read(restored, `after/${index}`)), files[index]!.after);
    }
    await fs.rm(restored, { recursive: true });
    await syncDirectory(directory);
    await syncDirectory(parent);
    await options.assertFrozen();
    if ((await inspectDuplicateProjectIds(options.source)).token !== choices.token)
      throw new LocalUpgradeDiagnosticError('repair-preview-stale');
    const journal: Journal = {
      id,
      sourceIdentity: localMetadataSourceIdentity(options.source),
      revision: options.revision,
      pausedAt: options.pausedAt,
      phase: 'applying',
      files,
      assignments,
      archiveHash: await hashBackupArchive(archive),
    };
    // From this durable point onward, normal cancel/copy/resume is fenced.
    await saveJournal(options.control, journal);
    await options.checkpoint?.('repair:prepared');
    await finishDuplicateProjectRepair(options);
  } catch (error) {
    // Failed preparation has not changed source data. Remove only this owned,
    // unpublished patch; never discard a patch referenced by durable recovery.
    let retained: Journal | null | undefined;
    try {
      retained = readJournal(options.control);
    } catch {
      // Keep recovery data if control state is unreadable.
    }
    if (retained !== undefined && retained?.id !== id) {
      await safePath(options.control, `project-id-repairs/${id}`);
      await fs.rm(directory, { recursive: true });
      await syncDirectory(parent);
    }
    throw error;
  }
}

export async function finishDuplicateProjectRepair(options: {
  control: string;
  source: LocalMetadataSourceRoots;
  revision: number;
  pausedAt: string;
  assertFrozen: () => Promise<void>;
  checkpoint?: (name: string) => Promise<void>;
}) {
  const journal = readJournal(options.control);
  if (
    !journal ||
    journal.phase !== 'applying' ||
    journal.sourceIdentity !== localMetadataSourceIdentity(options.source) ||
    journal.revision !== options.revision ||
    journal.pausedAt !== options.pausedAt
  )
    throw new Error('Repair recovery does not match the frozen source.');
  const directory = repairDirectory(options.control, journal.id);
  await safePath(options.control, `project-id-repairs/${journal.id}/repair-backup.tar.gz`);
  if ((await hashBackupArchive(path.join(directory, 'repair-backup.tar.gz'))) !== journal.archiveHash)
    throw new Error('Repair backup checksum mismatch.');
  // Validate the entire write set before changing the first file on recovery.
  for (let index = 0; index < journal.files.length; index++) {
    const file = journal.files[index]!;
    await safePath(options.source.workflows, file.path);
    await safePath(directory, `before/${index}`);
    await safePath(directory, `after/${index}`);
    if (
      hash(await read(directory, `before/${index}`)) !== file.before ||
      hash(await read(directory, `after/${index}`)) !== file.after
    )
      throw new Error('Repair patch checksum mismatch.');
    const current = hash(await read(options.source.workflows, file.path));
    if (current !== file.before && current !== file.after)
      throw new Error('Source differs from the recoverable repair.');
  }
  for (let index = 0; index < journal.files.length; index++) {
    await options.assertFrozen();
    const file = journal.files[index]!;
    const absolute = await safePath(options.source.workflows, file.path);
    if (hash(await read(options.source.workflows, file.path)) === file.after) continue;
    const relativeTemporary = path.posix.join(
      path.posix.dirname(file.path),
      `.project-id-repair-${journal.id}-${index}.tmp`,
    );
    const temporary = path.join(options.source.workflows, relativeTemporary);
    try {
      try {
        await safePath(options.source.workflows, relativeTemporary);
        if (!(await fs.lstat(temporary)).isFile()) throw new Error('Unsafe repair staging file.');
        // A process may have died mid-write. This exact journal-owned staging
        // name is disposable; it is never the original project or backup.
        await fs.rm(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await writeDurableExclusive(temporary, await read(directory, `after/${index}`), file.mode);
      if (hash(await read(options.source.workflows, file.path)) !== file.before)
        throw new Error('Source changed during repair.');
      await fs.rename(temporary, absolute);
      await syncDirectory(path.dirname(absolute));
    } finally {
      await fs.rm(temporary, { force: true });
    }
    await options.checkpoint?.(`repair:applied:${index}`);
  }
  await options.assertFrozen();
  for (const file of journal.files) {
    if (hash(await read(options.source.workflows, file.path)) !== file.after)
      throw new Error('Repaired source changed before completion.');
  }
  await saveJournal(options.control, { ...journal, phase: 'complete' });
}

export async function duplicateRepairDownload(control: string, id: string) {
  const journal = readJournal(control);
  if (!journal || journal.id !== id) throw new Error('Repair backup is unavailable.');
  const relative = `project-id-repairs/${journal.id}/repair-backup.tar.gz`;
  const archive = await safePath(control, relative);
  if ((await hashBackupArchive(archive)) !== journal.archiveHash) throw new Error('Repair backup checksum mismatch.');
  return archive;
}
