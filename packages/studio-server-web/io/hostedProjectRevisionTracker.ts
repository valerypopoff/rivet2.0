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
}

export function getHostedProjectExpectedRevision(projectId: string, path: string): string | null {
  const entry = getEntry(projectId);
  if (!entry) return null;
  entry.path = normalizePath(path);
  persistEntries();
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

export function restoreHostedProjectRevisionState(
  projectId: string,
  state: HostedProjectRevisionState | null,
): void {
  loadEntries();
  if (state) {
    entriesByProjectId.set(projectId, { ...state, path: normalizePath(state.path) });
  } else {
    entriesByProjectId.delete(projectId);
  }
  persistEntries();
}

/**
 * Observe the authoritative tree version without treating a remote content
 * edit as permission to overwrite that version on the next local save.
 */
export function observeHostedProjectRevision(options: {
  projectId: string;
  path: string;
  revisionId: string | null | undefined;
  structuralChange: boolean;
}): HostedProjectRemoteChange | null {
  if (!options.revisionId) return null;

  const current = getEntry(options.projectId);
  if (!current) {
    bindHostedProjectRevision(options.projectId, options.path, options.revisionId);
    return null;
  }

  current.path = normalizePath(options.path);
  if (options.structuralChange) {
    if (current.pendingRevisionId) {
      const pendingChanged = current.pendingRevisionId !== options.revisionId;
      current.pendingRevisionId = options.revisionId;
      persistEntries();
      return pendingChanged
        ? { projectId: options.projectId, path: current.path, revisionId: options.revisionId }
        : null;
    } else {
      current.acceptedRevisionId = options.revisionId;
    }
    persistEntries();
    return null;
  }

  if (current.pendingRevisionId === options.revisionId) {
    persistEntries();
    return { projectId: options.projectId, path: current.path, revisionId: options.revisionId };
  }
  if (current.acceptedRevisionId === options.revisionId) {
    persistEntries();
    return null;
  }

  current.pendingRevisionId = options.revisionId;
  persistEntries();
  return { projectId: options.projectId, path: current.path, revisionId: options.revisionId };
}

export function acceptHostedProjectRemoteRevision(
  projectId: string,
  path: string,
  revisionId: string,
): boolean {
  const current = getEntry(projectId);
  if (!current || current.pendingRevisionId !== revisionId) return false;
  current.path = normalizePath(path);
  current.acceptedRevisionId = revisionId;
  current.pendingRevisionId = null;
  persistEntries();
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
    changed = true;
  }
  if (changed) persistEntries();
}

export class HostedProjectRemoteChangePendingError extends Error {
  constructor(readonly projectId: string) {
    super('This project was changed by another administrator. Choose Reload or Keep mine in the update notification before saving.');
    this.name = 'HostedProjectRemoteChangePendingError';
  }
}

export function assertHostedProjectRevisionCanSave(projectId: string): void {
  if (getHostedProjectPendingRevision(projectId)) {
    throw new HostedProjectRemoteChangePendingError(projectId);
  }
}
