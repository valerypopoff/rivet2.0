import type { AsyncStorageBackend } from './indexedDB.js';
import { nanoid } from 'nanoid';

export const WORKSPACE_RECOVERY_PREFIX = 'workspace-recovery/v1/';
export const workspaceDocumentId = nanoid();
const SESSION_KEY = 'rivet-workspace-recovery-v1';
// General preferences, plugin settings and the shared Evaluation library are
// deliberately not window-local. These groups describe one editor workspace.
export const workspaceRecoveryGroups = new Set(['project', 'graph', 'graphBuilder']);

type Checkpoint = {
  version: 1;
  revision: number;
  updatedAt: string;
  groups: Record<string, Record<string, unknown>>;
};
export type RecoveryHealth = {
  status: 'saved' | 'pending' | 'unavailable';
  revision: number;
  committedRevision: number;
  reloadAvailable: boolean;
};

/** Automatic retries cannot repair an invalid authority without user choice. */
export class WorkspaceRecoveryDataError extends Error {
  constructor(
    message: string,
    readonly canChooseRecovery = true,
  ) {
    super(message);
  }
}

export class WorkspaceRecoveryAccessError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate workspace-owned content before atoms can substitute empty defaults.
 * Unknown preference fields remain compatible; known authorities fail closed. */
export function validateRecoveryGroups(groups: Checkpoint['groups']): void {
  function invalid(field: string): never {
    throw new WorkspaceRecoveryDataError(`Invalid workspace recovery ${field}. The original record has been retained.`);
  }
  const payload = (value: unknown, field: string) => {
    if (value !== undefined && (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')))
      invalid(field);
  };
  const graph = (value: unknown, field: string, expectedId?: string) => {
    if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.connections)) invalid(field);
    const metadata = value.metadata;
    if (metadata !== undefined && !isRecord(metadata)) invalid(field);
    if (expectedId && (!isRecord(metadata) || metadata.id !== expectedId)) invalid(`${field} identity`);
    const ids = new Set<string>();
    for (const node of value.nodes as unknown[]) {
      if (!isRecord(node) || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string') invalid(field);
      if (ids.has(node.id)) invalid(`${field} duplicate node identity`);
      ids.add(node.id);
    }
    if ((value.connections as unknown[]).some((connection) => !isRecord(connection))) invalid(field);
  };
  const project = (value: unknown, field: string, expectedId?: string) => {
    if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.graphs)) invalid(field);
    if (
      typeof value.metadata.id !== 'string' ||
      !value.metadata.id ||
      typeof value.metadata.title !== 'string' ||
      (expectedId !== undefined && value.metadata.id !== expectedId)
    )
      invalid(`${field} identity`);
    for (const [id, item] of Object.entries(value.graphs)) graph(item, `${field} graph`, id);
    payload(value.data, `${field} payload`);
  };
  for (const [key, group] of Object.entries(groups)) {
    if (!workspaceRecoveryGroups.has(key) || !isRecord(group)) invalid('group');
  }
  const state = groups.project;
  if (state) {
    if (state.projectState !== undefined) project(state.projectState, 'project');
    payload(state.projectDataState, 'payload');
    if (state.loadedProjectState !== undefined) {
      const loaded = state.loadedProjectState;
      if (
        !isRecord(loaded) ||
        typeof loaded.loaded !== 'boolean' ||
        (loaded.path !== null && typeof loaded.path !== 'string')
      )
        invalid('loaded path');
    }
    if (state.openedProjectSnapshotsState !== undefined) {
      if (!isRecord(state.openedProjectSnapshotsState)) invalid('snapshots');
      for (const [id, snapshot] of Object.entries(state.openedProjectSnapshotsState)) {
        if (!isRecord(snapshot)) invalid('snapshot');
        project(snapshot.project, 'snapshot', id);
        payload(snapshot.data, 'snapshot payload');
      }
    }
    if (state.projectsState !== undefined) {
      const tabs = state.projectsState;
      if (!isRecord(tabs) || !isRecord(tabs.openedProjects) || !Array.isArray(tabs.openedProjectsSortedIds))
        invalid('tabs');
      const ids = tabs.openedProjectsSortedIds as unknown[];
      const opened = tabs.openedProjects;
      if (new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !(id in opened)))
        invalid('tab order');
      for (const [id, tab] of Object.entries(tabs.openedProjects)) {
        if (
          !isRecord(tab) ||
          tab.projectId !== id ||
          typeof tab.title !== 'string' ||
          (tab.fsPath !== undefined && tab.fsPath !== null && typeof tab.fsPath !== 'string')
        )
          invalid('tab identity');
      }
    }
    for (const key of [
      'savedProjectContentDigestsState',
      'projectUnsavedChangesState',
      'projectDataUnsavedChangesState',
    ]) {
      const value = state[key];
      const type = key === 'savedProjectContentDigestsState' ? 'string' : 'boolean';
      if (
        value !== undefined &&
        (!isRecord(value) || Object.values(value).some((item) => item !== undefined && typeof item !== type))
      )
        invalid(key);
    }
  }
  if (groups.graph?.graphState !== undefined) {
    graph(groups.graph.graphState, 'active graph');
    if (state?.projectState === undefined) invalid('active project is missing');
  }
}

export function parseRecoveryCheckpoint(raw: string): Checkpoint {
  let value: Checkpoint;
  try {
    value = JSON.parse(raw) as Checkpoint;
  } catch {
    throw new WorkspaceRecoveryDataError(
      'Invalid workspace recovery checkpoint. The original record has been retained.',
    );
  }
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.updatedAt !== 'string' ||
    !value.groups ||
    typeof value.groups !== 'object' ||
    Array.isArray(value.groups)
  )
    throw new WorkspaceRecoveryDataError(
      'Invalid workspace recovery checkpoint. The original record has been retained.',
    );
  validateRecoveryGroups(value.groups);
  return value;
}

/** One document, one writer. Reload/duplicate reads the previous checkpoint but
 * writes a fresh key, so no lease, unload handshake or cross-window lock is needed. */
export class WorkspaceRecoveryStorage implements AsyncStorageBackend {
  readonly key: string;
  readonly #listeners = new Set<() => void>();
  #session?: Storage;
  readonly #resolveSession?: () => Storage | undefined;
  #sourceKey: string | null;
  #referenceReadPending = false;
  #source?: Promise<Checkpoint | null>;
  #hasWrittenCheckpoint = false;
  #tail: Promise<void> = Promise.resolve();
  #health: RecoveryHealth;
  #retired = false;
  #selected = true;
  #selectionRevision = 0;
  setSelected(selected: boolean): void {
    if (this.#selected !== selected) this.#selectionRevision++;
    this.#selected = selected;
  }
  get persistsAcrossReload(): boolean {
    return this.backend.persistsAcrossReload !== false;
  }
  get retired(): boolean {
    return this.#retired;
  }
  get hasSelectedCheckpoint(): boolean {
    return this.#sourceKey !== null || this.#hasWrittenCheckpoint;
  }

  constructor(
    readonly backend: AsyncStorageBackend,
    readonly capture: () => Checkpoint['groups'],
    options: {
      session?: Storage;
      id?: string;
      sessionUnavailable?: boolean;
      resolveSession?: () => Storage | undefined;
    } = {},
  ) {
    // Host backends can be replaced within one document. Distinct wrappers
    // must not share a writer key even if their physical stores overlap.
    this.key = WORKSPACE_RECOVERY_PREFIX + (options.id ?? `${workspaceDocumentId}/${nanoid()}`);
    this.#session = options.session;
    this.#resolveSession = options.resolveSession;
    this.#referenceReadPending = options.sessionUnavailable ?? false;
    let source: string | null = null;
    let reloadAvailable = false;
    try {
      source = this.#session?.getItem(SESSION_KEY) ?? null;
      reloadAvailable = this.#session !== undefined && this.persistsAcrossReload;
    } catch {
      source = null;
      this.#referenceReadPending = true;
    }
    this.#sourceKey = source;
    this.#health = { status: 'saved', revision: 0, committedRevision: 0, reloadAvailable };
  }

  getHealth = (): RecoveryHealth => this.#health;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(health: RecoveryHealth): void {
    this.#health = health;
    for (const listener of this.#listeners) listener();
  }
  changed(): void {
    this.#publish({ ...this.#health, status: 'pending', revision: this.#health.revision + 1 });
  }
  failed(): void {
    this.#publish({ ...this.#health, status: 'unavailable' });
  }

  #getSession(): Storage | undefined {
    return (this.#session ??= this.#resolveSession?.());
  }

  async #readSource(): Promise<Checkpoint | null> {
    if (this.#referenceReadPending) {
      // An inaccessible reference is unknown recovery, not permission to
      // import stale legacy data. Retry it without losing the original choice.
      try {
        const session = this.#getSession();
        if (!session) throw new Error('Session storage access is blocked');
        this.#sourceKey = session.getItem(SESSION_KEY);
        this.#referenceReadPending = false;
      } catch {
        throw new WorkspaceRecoveryAccessError(
          'Browser recovery reference is unavailable. Retry when session storage is accessible.',
        );
      }
    }
    if (this.#sourceKey === null) return null;
    if (!this.#sourceKey.startsWith(WORKSPACE_RECOVERY_PREFIX))
      throw new WorkspaceRecoveryDataError('Invalid recovery reference. The original reference was retained.');
    const raw = await this.backend.getItem(this.#sourceKey);
    if (raw === null)
      throw new WorkspaceRecoveryDataError(
        'The selected workspace recovery checkpoint is missing. Choose another recovery or explicitly start empty.',
      );
    return parseRecoveryCheckpoint(raw);
  }
  async getItem(key: string): Promise<string | null> {
    if (!workspaceRecoveryGroups.has(key)) return this.backend.getItem(key);
    const pending = (this.#source ??= this.#readSource());
    let source: Checkpoint | null;
    try {
      source = await pending;
    } catch (error) {
      // Do not permanently poison this provider after transient IO failure,
      // or clear a newer committed checkpoint when an old read finally fails.
      if (this.#source === pending) this.#source = undefined;
      if (error instanceof WorkspaceRecoveryDataError || error instanceof WorkspaceRecoveryAccessError) throw error;
      throw new WorkspaceRecoveryAccessError(error instanceof Error ? error.message : String(error));
    }
    // Never mix a new checkpoint with unrelated legacy fragments.
    if (source) return source.groups[key] ? JSON.stringify(source.groups[key]) : null;
    return this.backend.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!workspaceRecoveryGroups.has(key)) return this.backend.setItem(key, value);
    if (this.#retired) throw new Error('Recovery selection changed. Reload before editing this workspace.');
    const revision = this.#health.revision;
    // Capture all groups before yielding. The physical write is one atomic
    // record, including project, graph and baseline from the same JS turn.
    let serialized: string;
    try {
      serialized = JSON.stringify({
        version: 1,
        revision,
        updatedAt: new Date().toISOString(),
        groups: this.capture(),
      } satisfies Checkpoint);
      parseRecoveryCheckpoint(serialized);
    } catch (error) {
      this.failed();
      throw error;
    }
    const write = async () => {
      try {
        await this.backend.setItem(this.key, serialized);
        await this.#verifyWrite(this.key, serialized);
        this.#source = Promise.resolve(parseRecoveryCheckpoint(serialized));
        this.#hasWrittenCheckpoint = true;
        let reloadAvailable = this.#health.reloadAvailable;
        try {
          if (!this.#retired && this.#selected && this.persistsAcrossReload) {
            const session = this.#getSession();
            if (session) {
              session.setItem(SESSION_KEY, this.key);
              reloadAvailable = true;
            }
          }
        } catch {
          reloadAvailable = false;
        }
        this.#publish({
          ...this.#health,
          reloadAvailable,
          committedRevision: revision,
          status: revision === this.#health.revision ? 'saved' : 'pending',
        });
      } catch (error) {
        this.#publish({ ...this.#health, status: 'unavailable' });
        throw error;
      }
    };
    this.#tail = this.#tail.then(write, write);
    return this.#tail;
  }
  async #verifyWrite(key: string, serialized: string): Promise<void> {
    const stored = await this.backend.getItem(key);
    if (stored !== serialized)
      throw new Error('Browser recovery read-back verification failed. The recovery reference was not advanced.');
    parseRecoveryCheckpoint(stored);
  }
  async removeItem(key: string): Promise<void> {
    if (workspaceRecoveryGroups.has(key))
      throw new Error('Workspace recovery must be replaced atomically, not removed group by group.');
    return this.backend.removeItem(key);
  }

  async listRecoveries(): Promise<Array<{ key: string; title: string; updatedAt: string; invalid: boolean }>> {
    const keys = (await this.backend.listKeys?.(WORKSPACE_RECOVERY_PREFIX)) ?? [];
    const records = [];
    for (const key of keys) {
      try {
        const raw = await this.backend.getItem(key);
        if (raw === null) continue;
        const checkpoint = parseRecoveryCheckpoint(raw);
        const project = checkpoint.groups.project?.projectState as { metadata?: { title?: string } } | undefined;
        records.push({
          key,
          title: project?.metadata?.title ?? 'Workspace',
          updatedAt: checkpoint.updatedAt,
          invalid: false,
        });
      } catch {
        records.push({ key, title: 'Unreadable checkpoint (retained)', updatedAt: '', invalid: true });
      }
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async selectRecovery(key: string | null): Promise<void> {
    if (!this.persistsAcrossReload)
      throw new Error(
        'Memory-only recovery cannot survive reload. Use persistent browser storage before selecting recovery.',
      );
    const session = this.#getSession();
    if (!session) throw new Error('Browser session storage is unavailable; recovery selection cannot survive reload.');
    const revision = ++this.#selectionRevision;
    const assertCurrent = () => {
      if (this.#retired || !this.#selected || this.#selectionRevision !== revision)
        throw new Error('Recovery selection changed. Reload before selecting another workspace.');
    };
    assertCurrent();
    let serialized: string;
    if (key) {
      if (!key.startsWith(WORKSPACE_RECOVERY_PREFIX)) throw new Error('Invalid recovery reference');
      const raw = await this.backend.getItem(key);
      if (raw === null) throw new Error('Recovery checkpoint is missing');
      parseRecoveryCheckpoint(raw);
      serialized = raw;
    } else {
      // An explicit empty checkpoint prevents re-importing legacy data. Never
      // delete the previous recovery or legacy records as part of this choice.
      serialized = JSON.stringify({
        version: 1,
        revision: 0,
        updatedAt: new Date().toISOString(),
        groups: {},
      } satisfies Checkpoint);
    }
    assertCurrent();
    // The chosen writer might still be active, even in another window. Freeze
    // its exact bytes under a fresh key that no live writer owns before reload.
    const selectedKey = WORKSPACE_RECOVERY_PREFIX + nanoid();
    await this.backend.setItem(selectedKey, serialized);
    await this.#verifyWrite(selectedKey, serialized);
    assertCurrent();
    session.setItem(SESSION_KEY, selectedKey);
    // A queued old checkpoint may still finish during reload; it must not
    // replace the user's explicit recovery choice in sessionStorage.
    this.#retired = true;
  }
}
