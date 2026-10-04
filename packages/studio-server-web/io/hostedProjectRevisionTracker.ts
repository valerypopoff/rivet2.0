import type {
  HostedProjectConflictSnapshot,
  HostedProjectReconciliationContext,
} from '../../studio-server-shared/editor-bridge';
import { createHybridStorage } from '../../app/src/state/storage.js';

type HostedProjectRevisionEntry = {
  projectId: string;
  path: string;
  acceptedRevisionId: string | null;
  pendingRevisionId: string | null;
};

export type HostedProjectRevisionState = Readonly<HostedProjectRevisionEntry>;

export type HostedProjectRemoteChange = {
  projectId: string;
  path: string;
  revisionId: string;
};

const RECOVERY_STORAGE_KEY = 'hostedProjectRevisions';
const { storage: recoveryStorage } = createHybridStorage('project');
const MAX_ENTRIES = 200;
const entriesByProjectId = new Map<string, HostedProjectRevisionEntry>();
let initialized = false;
export const hostedEditorInstanceId =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let generation = 0;
let observationSequence = 0;
let snapshotSequence = 0;
let recheckSequence = 0;
const runtimeByProjectId = new Map<string, { generation: number; lastObservation: number; changeId: string | null }>();
const savesByProjectId = new Map<string, number>();
const reloadsByProjectId = new Map<string, { entry: HostedProjectRevisionState | null; changeId: string | null }>();
const awaitingTabRegistration = new Set<string>();
const listeners = new Set<() => void>();

function runtime(projectId: string) {
  let value = runtimeByProjectId.get(projectId);
  if (!value) {
    value = { generation: ++generation, lastObservation: 0, changeId: null };
    runtimeByProjectId.set(projectId, value);
  }
  return value;
}

function notifyRevisionChanged(projectId: string, recheck: boolean, newConflict = false): void {
  const state = runtime(projectId);
  state.generation = ++generation;
  if (newConflict) state.changeId = `${hostedEditorInstanceId}:${state.generation}`;
  if (recheck) recheckSequence++;
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('Failed to publish project revision state:', error);
    }
  }
}

export function subscribeHostedProjectRevisions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function beginHostedProjectSave(projectId: string): () => void {
  if (reloadsByProjectId.has(projectId)) throw new Error('Wait for this project to finish reloading before saving.');
  savesByProjectId.set(projectId, (savesByProjectId.get(projectId) ?? 0) + 1);
  notifyRevisionChanged(projectId, false);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const remaining = (savesByProjectId.get(projectId) ?? 1) - 1;
    if (remaining) savesByProjectId.set(projectId, remaining);
    else savesByProjectId.delete(projectId);
    notifyRevisionChanged(projectId, true);
  };
}

/** Candidate IO binds are provisional until the editor accepts the replacement. */
export function beginHostedProjectReload(projectId: string): (accepted?: boolean) => void {
  if (savesByProjectId.has(projectId) || reloadsByProjectId.has(projectId)) {
    throw new Error('Wait for the current project save or reload to finish.');
  }
  reloadsByProjectId.set(projectId, {
    entry: getHostedProjectRevisionState(projectId),
    changeId: runtime(projectId).changeId,
  });
  notifyRevisionChanged(projectId, false);
  return (accepted = true) => {
    const reload = reloadsByProjectId.get(projectId);
    if (!reload) return;
    reloadsByProjectId.delete(projectId);
    const current = getEntry(projectId);
    if (!accepted && current) {
      // Candidate IO may have bound a revision before the editor rejected it.
      // Restore content authority, but keep a concurrent move's current path.
      // A pruned/closed tab must never be resurrected by rollback.
      if (reload.entry) entriesByProjectId.set(projectId, { ...reload.entry, path: current.path });
      else entriesByProjectId.delete(projectId);
    }
    persistEntries();
    notifyRevisionChanged(projectId, true, !accepted && Boolean(reload.entry?.pendingRevisionId));
  };
}

export function captureHostedProjectReconciliation(projectIds: Iterable<string>): HostedProjectReconciliationContext {
  loadEntries();
  return {
    editorInstanceId: hostedEditorInstanceId,
    observationSequence: ++observationSequence,
    projects: [...projectIds]
      .filter((id) => !savesByProjectId.has(id) && !reloadsByProjectId.has(id))
      .map((projectId) => ({
        projectId,
        generation: runtime(projectId).generation,
      })),
  };
}

/** Claim once, before changing either the revision or the editor binding. */
export function claimHostedProjectObservation(
  context: HostedProjectReconciliationContext,
  projectId: string,
): 'applied' | 'retry' | 'waiting-for-save' {
  if (savesByProjectId.has(projectId) || reloadsByProjectId.has(projectId)) return 'waiting-for-save';
  const state = runtime(projectId);
  if (
    context.editorInstanceId !== hostedEditorInstanceId ||
    context.projects.find((entry) => entry.projectId === projectId)?.generation !== state.generation ||
    context.observationSequence <= state.lastObservation ||
    context.observationSequence > observationSequence
  )
    return 'retry';
  state.lastObservation = context.observationSequence;
  return 'applied';
}

export function getHostedProjectConflictSnapshot(
  projects: Iterable<{ projectId: string; title: string }>,
): HostedProjectConflictSnapshot {
  const contentChanges: HostedProjectConflictSnapshot['contentChanges'] = [];
  for (const { projectId, title } of projects) {
    const reload = reloadsByProjectId.get(projectId);
    const entry = reload ? reload.entry : getEntry(projectId);
    if (!entry?.pendingRevisionId) continue;
    const state = runtime(projectId);
    state.changeId ??= `${hostedEditorInstanceId}:${state.generation}`;
    contentChanges.push({
      projectId,
      title,
      path: entry.path,
      revisionId: entry.pendingRevisionId,
      changeId: reload?.changeId ?? state.changeId,
    });
  }
  // An open tab's displayed title may change without a revision transition.
  // Every complete publication must outrank a prior snapshot of that tab set.
  return { editorInstanceId: hostedEditorInstanceId, sequence: ++snapshotSequence, recheckSequence, contentChanges };
}

export function matchesHostedProjectConflict(
  projectId: string,
  path: string,
  revisionId: string,
  changeId: string,
): boolean {
  const entry = getEntry(projectId);
  return (
    entry?.path === normalizePath(path) &&
    entry.pendingRevisionId === revisionId &&
    runtime(projectId).changeId === changeId
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function loadEntries(): void {
  if (initialized) return;
  initialized = true;
  try {
    // Authority must travel in the same atomic checkpoint as its workspace,
    // not in a separately writable session/localStorage cache. Legacy caches
    // remain untouched; recovered tabs without authority require review.
    const parsed: unknown = recoveryStorage.getItem(RECOVERY_STORAGE_KEY, []);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed.slice(-MAX_ENTRIES)) {
      if (
        typeof value !== 'object' ||
        value == null ||
        typeof (value as HostedProjectRevisionEntry).projectId !== 'string' ||
        typeof (value as HostedProjectRevisionEntry).path !== 'string' ||
        !(
          (value as HostedProjectRevisionEntry).acceptedRevisionId === null ||
          typeof (value as HostedProjectRevisionEntry).acceptedRevisionId === 'string'
        ) ||
        !(
          (value as HostedProjectRevisionEntry).pendingRevisionId === null ||
          typeof (value as HostedProjectRevisionEntry).pendingRevisionId === 'string'
        )
      ) {
        continue;
      }
      const entry = value as HostedProjectRevisionEntry;
      entriesByProjectId.set(entry.projectId, { ...entry, path: normalizePath(entry.path) });
    }
  } catch {
    // Keep loading usable. Missing revision authority requires explicit review
    // before an in-place save; it must never silently adopt the remote version.
  }
}

function persistEntries(): void {
  const next = [...entriesByProjectId.values()]
    .filter((entry) => !awaitingTabRegistration.has(entry.projectId))
    // An unfinished reload cannot certify its candidate disk revision in a
    // checkpoint that still contains the old editor snapshot.
    .map((entry) => (reloadsByProjectId.has(entry.projectId) ? reloadsByProjectId.get(entry.projectId)!.entry : entry))
    .filter((entry) => entry !== null)
    .slice(-MAX_ENTRIES)
    .map((entry) => ({ ...entry }));
  const previous: unknown = recoveryStorage.getItem(RECOVERY_STORAGE_KEY, []);
  if (
    Array.isArray(previous) &&
    previous.length === next.length &&
    next.every((entry, index) => {
      const saved = previous[index];
      return (
        saved?.projectId === entry.projectId &&
        saved.path === entry.path &&
        saved.acceptedRevisionId === entry.acceptedRevisionId &&
        saved.pendingRevisionId === entry.pendingRevisionId
      );
    })
  )
    return;
  // Identical background observations must not create pending recovery writes
  // or unload warnings for an otherwise unchanged workspace.
  recoveryStorage.setItem(RECOVERY_STORAGE_KEY, next);
}

function getEntry(projectId: string): HostedProjectRevisionEntry | undefined {
  loadEntries();
  return entriesByProjectId.get(projectId);
}

export function bindHostedProjectRevision(
  projectId: string,
  path: string,
  revisionId: string | null,
  options: { awaitingActivation?: boolean } = {},
): void {
  loadEntries();
  if (options.awaitingActivation && !reloadsByProjectId.has(projectId)) awaitingTabRegistration.add(projectId);
  entriesByProjectId.set(projectId, {
    projectId,
    path: normalizePath(path),
    acceptedRevisionId: revisionId,
    pendingRevisionId: null,
  });
  persistEntries();
  notifyRevisionChanged(projectId, true);
}

export function getHostedProjectExpectedRevision(projectId: string, path: string): string | null {
  const entry = getEntry(projectId);
  if (!entry) return null;
  const nextPath = normalizePath(path);
  if (entry.path !== nextPath) {
    entry.path = nextPath;
    persistEntries();
    notifyRevisionChanged(projectId, true, Boolean(entry.pendingRevisionId));
  }
  return entry.acceptedRevisionId;
}

export function getHostedProjectPendingRevision(projectId: string): string | null {
  return getEntry(projectId)?.pendingRevisionId ?? null;
}

/**
 * Loading a candidate replacement snapshot updates its revision through the
 * normal IO provider. The reload lifecycle retains this state until its
 * settlement accepts or rejects the replacement.
 */
export function getHostedProjectRevisionState(projectId: string): HostedProjectRevisionState | null {
  const entry = getEntry(projectId);
  return entry ? { ...entry } : null;
}

/**
 * Observe the authoritative tree version without treating a remote content
 * edit as permission to overwrite that version on the next local save.
 */
export function observeHostedProjectRevision(options: {
  projectId: string;
  path: string;
  revisionId: string | null | undefined;
}): HostedProjectRemoteChange | null {
  if (!options.revisionId) return null;

  const current = getEntry(options.projectId);
  if (!current) {
    // A tree observation is not evidence that a recovered snapshot loaded
    // this revision. Missing document-local authority requires an explicit
    // Reload/Keep mine decision, including after upgrading the cache format.
    entriesByProjectId.set(options.projectId, {
      projectId: options.projectId,
      path: normalizePath(options.path),
      acceptedRevisionId: null,
      pendingRevisionId: options.revisionId,
    });
    persistEntries();
    notifyRevisionChanged(options.projectId, true, true);
    return { projectId: options.projectId, path: normalizePath(options.path), revisionId: options.revisionId };
  }

  const pathChanged = current.path !== normalizePath(options.path);
  current.path = normalizePath(options.path);
  if (current.acceptedRevisionId === options.revisionId) {
    const hadPendingRevision = Boolean(current.pendingRevisionId);
    if (hadPendingRevision) {
      current.pendingRevisionId = null;
    }
    persistEntries();
    if (hadPendingRevision || pathChanged) notifyRevisionChanged(options.projectId, pathChanged);
    return null;
  }
  if (current.pendingRevisionId === options.revisionId) {
    persistEntries();
    if (pathChanged) notifyRevisionChanged(options.projectId, true, true);
    return { projectId: options.projectId, path: current.path, revisionId: options.revisionId };
  }

  current.pendingRevisionId = options.revisionId;
  persistEntries();
  notifyRevisionChanged(options.projectId, pathChanged, true);
  return { projectId: options.projectId, path: current.path, revisionId: options.revisionId };
}

export function acceptHostedProjectRemoteRevision(projectId: string, path: string, revisionId: string): boolean {
  const current = getEntry(projectId);
  if (!current || current.pendingRevisionId !== revisionId) return false;
  current.path = normalizePath(path);
  current.acceptedRevisionId = revisionId;
  current.pendingRevisionId = null;
  persistEntries();
  notifyRevisionChanged(projectId, true);
  return true;
}

export function clearHostedProjectRevisionPath(path: string | null | undefined): void {
  if (!path) return;
  loadEntries();
  const normalizedPath = normalizePath(path);
  let changed = false;
  for (const [projectId, entry] of entriesByProjectId.entries()) {
    if (entry.path !== normalizedPath) continue;
    entriesByProjectId.delete(projectId);
    awaitingTabRegistration.delete(projectId);
    notifyRevisionChanged(projectId, true);
    changed = true;
  }
  if (changed) persistEntries();
}

export function remapHostedProjectRevisionPaths(
  moves: Iterable<{ fromAbsolutePath: string; toAbsolutePath: string }>,
): void {
  loadEntries();
  const moveMap = new Map<string, string>();
  for (const move of moves) {
    moveMap.set(normalizePath(move.fromAbsolutePath), normalizePath(move.toAbsolutePath));
  }
  let changed = false;
  for (const entry of entriesByProjectId.values()) {
    const nextPath = moveMap.get(entry.path);
    if (!nextPath) continue;
    entry.path = nextPath;
    notifyRevisionChanged(entry.projectId, true, Boolean(entry.pendingRevisionId));
    changed = true;
  }
  if (changed) persistEntries();
}

export function pruneHostedProjectRevisions(openProjectIds: Iterable<string>): void {
  loadEntries();
  const openIds = new Set(openProjectIds);
  let changed = false;
  // Initial IO binds precede actual tab registration. Loading placeholders or
  // an unrelated tab update must not discard that candidate's revision. It is
  // eligible for recovery only after the workspace confirms the real tab.
  for (const projectId of openIds) changed = awaitingTabRegistration.delete(projectId) || changed;
  for (const projectId of entriesByProjectId.keys()) {
    if (openIds.has(projectId) || awaitingTabRegistration.has(projectId)) continue;
    entriesByProjectId.delete(projectId);
    notifyRevisionChanged(projectId, true);
    changed = true;
  }
  for (const projectId of runtimeByProjectId.keys()) {
    if (
      !openIds.has(projectId) &&
      !awaitingTabRegistration.has(projectId) &&
      !savesByProjectId.has(projectId) &&
      !reloadsByProjectId.has(projectId)
    ) {
      runtimeByProjectId.delete(projectId);
    }
  }
  if (changed) persistEntries();
}

export class HostedProjectRemoteChangePendingError extends Error {
  constructor(readonly projectId: string) {
    super(
      'The saved version differs from the version open in this tab. Choose Reload or Keep mine in the update notification before saving.',
    );
    this.name = 'HostedProjectRemoteChangePendingError';
  }
}

export function assertHostedProjectRevisionCanSave(projectId: string): void {
  if (reloadsByProjectId.has(projectId)) throw new Error('Wait for this project to finish reloading before saving.');
  if (!getEntry(projectId))
    throw new Error(
      'The saved revision for this recovered tab is unknown. Wait for the update notification, then choose Reload or Keep mine before saving.',
    );
  if (getHostedProjectPendingRevision(projectId)) {
    throw new HostedProjectRemoteChangePendingError(projectId);
  }
}
