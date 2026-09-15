import type {
  HostedProjectConflictSnapshot,
  HostedProjectReconciliationContext,
} from '../../studio-server-shared/editor-bridge';

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

const BROWSER_STORAGE_KEY = 'rivet.hosted-project-revisions.v1';
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
export function beginHostedProjectReload(projectId: string): () => void {
  if (savesByProjectId.has(projectId) || reloadsByProjectId.has(projectId)) {
    throw new Error('Wait for the current project save or reload to finish.');
  }
  reloadsByProjectId.set(projectId, {
    entry: getHostedProjectRevisionState(projectId),
    changeId: runtime(projectId).changeId,
  });
  notifyRevisionChanged(projectId, false);
  return () => {
    if (!reloadsByProjectId.delete(projectId)) return;
    notifyRevisionChanged(projectId, true);
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

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    // Some embedded browser contexts prohibit persistent local storage. Keep
    // same-tab reconnect protection when session storage remains available.
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
}

function loadEntries(): void {
  if (initialized) return;
  initialized = true;
  const storage = getBrowserStorage();
  if (!storage) return;

  try {
    const raw = storage.getItem(BROWSER_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
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
    // Session storage is a reconnect aid only. A malformed or unavailable
    // entry must never interfere with loading or saving an editable project.
  }
}

function persistEntries(): void {
  const storage = getBrowserStorage();
  if (!storage) return;
  try {
    storage.setItem(BROWSER_STORAGE_KEY, JSON.stringify([...entriesByProjectId.values()].slice(-MAX_ENTRIES)));
  } catch {
    // Browser privacy/storage failures only remove reconnect detection. The
    // in-memory compare-and-swap state remains valid for this session.
  }
}

function getEntry(projectId: string): HostedProjectRevisionEntry | undefined {
  loadEntries();
  return entriesByProjectId.get(projectId);
}

export function bindHostedProjectRevision(projectId: string, path: string, revisionId: string | null): void {
  loadEntries();
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
 * normal IO provider. Callers that can still reject that replacement retain
 * this state and restore it on failure, so a failed reload cannot authorize a
 * later overwrite of the remote version.
 */
export function getHostedProjectRevisionState(projectId: string): HostedProjectRevisionState | null {
  const entry = getEntry(projectId);
  return entry ? { ...entry } : null;
}

export function restoreHostedProjectRevisionState(projectId: string, state: HostedProjectRevisionState | null): void {
  loadEntries();
  if (state) {
    entriesByProjectId.set(projectId, { ...state, path: normalizePath(state.path) });
  } else {
    entriesByProjectId.delete(projectId);
  }
  persistEntries();
  notifyRevisionChanged(projectId, true, Boolean(state?.pendingRevisionId));
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
    bindHostedProjectRevision(options.projectId, options.path, options.revisionId);
    return null;
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
  for (const projectId of entriesByProjectId.keys()) {
    if (openIds.has(projectId)) continue;
    entriesByProjectId.delete(projectId);
    notifyRevisionChanged(projectId, true);
    changed = true;
  }
  for (const projectId of runtimeByProjectId.keys()) {
    if (!openIds.has(projectId) && !savesByProjectId.has(projectId) && !reloadsByProjectId.has(projectId)) {
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
  if (getHostedProjectPendingRevision(projectId)) {
    throw new HostedProjectRemoteChangePendingError(projectId);
  }
}
