import type {
  EvaluationLibraryConflictDraft,
  EvaluationLibraryConflictResolution,
  EvaluationLibraryConflictResource,
  EvaluationLibraryMutation,
  EvaluationLibraryMutationChange,
  EvaluationLibraryResourceKind,
  EvaluationLibraryResourceVersions,
  EvaluationLibraryResourceValue,
  EvaluationLibrarySyncIssue,
  EvaluationLibrarySyncSnapshot,
  EvaluationDatasetSnapshot,
  EvaluationLibrary,
  EvaluationRecordingArtifact,
  EvaluationRun,
  EvaluationRunEvent,
  EvaluationStore,
  EvaluationStoreInitialization,
} from "@valerypopoff/rivet2-evaluations";
import {
  applyEvaluationLibraryMutation,
  diffEvaluationLibraryMutation,
  evaluationLibraryValueEquals,
  getEvaluationLibraryResource,
} from "@valerypopoff/rivet2-evaluations";

export type LegacyEvaluationLibrarySource = Pick<
  EvaluationStore,
  "getLibrary" | "initialize"
>;

type EvaluationLibrarySnapshot = EvaluationLibrarySyncSnapshot & {
  supportsResourceMutations: boolean;
};

const EVALUATION_LIBRARY_CLIENT_ID_HEADER = "x-rivet-evaluation-library-client-id";

export class EvaluationLibraryResourceConflictError extends Error {
  readonly conflicts: readonly EvaluationLibraryConflictResource[];
  readonly snapshot?: EvaluationLibrarySyncSnapshot;

  constructor(input: {
    message: string;
    conflicts: readonly EvaluationLibraryConflictResource[];
    snapshot?: EvaluationLibrarySyncSnapshot;
  }) {
    super(input.message);
    this.name = "EvaluationLibraryResourceConflictError";
    this.conflicts = input.conflicts;
    this.snapshot = input.snapshot;
  }
}

class EvaluationLibraryRequestError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'EvaluationLibraryRequestError';
    this.status = status;
    this.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  }
}

function url(baseUrl: string, path = ""): string {
  return `${baseUrl.replace(/\/$/u, "")}${path}`;
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
  } | null;
  throw new EvaluationLibraryRequestError(
    typeof body?.error === "string"
      ? body.error
      : `Evaluation storage request failed (${response.status}).`,
    response.status,
  );
}

function hasLibraryContent(library: EvaluationLibrary): boolean {
  return (
    library.data.suites.length > 0 ||
    library.data.baselines.length > 0 ||
    library.datasets.length > 0 ||
    library.migratedLegacyProjectIds.length > 0
  );
}

/**
 * Resource-scoped mutations are safe only when the server supplied a token
 * for every resource that the client could update or delete. Older servers
 * and intermediary caches may return a partial map; preserve their guarded
 * whole-library compatibility path instead of failing a normal save locally.
 */
function hasCompleteResourceVersions(
  library: EvaluationLibrary,
  value: unknown,
): value is EvaluationLibraryResourceVersions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const versions = value as Partial<EvaluationLibraryResourceVersions>;
  if (
    typeof versions.suites !== 'object' ||
    versions.suites === null ||
    Array.isArray(versions.suites) ||
    typeof versions.datasets !== 'object' ||
    versions.datasets === null ||
    Array.isArray(versions.datasets)
  ) {
    return false;
  }
  const hasToken = (tokens: Record<string, unknown>, id: string): boolean =>
    Object.prototype.hasOwnProperty.call(tokens, id) &&
    typeof tokens[id] === 'string' &&
    tokens[id].length > 0;
  return (
    library.data.suites.every((suite) => hasToken(versions.suites!, suite.id)) &&
    library.datasets.every((dataset) => hasToken(versions.datasets!, dataset.id))
  );
}

/** Complete hosted Evaluations store backed by the wrapper API. */
export function createHttpEvaluationStore(options: {
  baseUrl: string;
  normalizeRun(value: unknown): EvaluationRun;
  normalizeLibrary(value: unknown): EvaluationLibrary;
  legacyLibrarySource?: LegacyEvaluationLibrarySource;
}): EvaluationStore {
  let librarySnapshot: EvaluationLibrarySnapshot | undefined;
  let initializationPromise:
    | Promise<EvaluationStoreInitialization | void>
    | undefined;
  let optimisticLibrary: EvaluationLibrary | undefined;
  let legacyLibraryWrite = Promise.resolve();
  const libraryListeners = new Set<() => void>();
  const librarySyncIssueListeners = new Set<(issue: EvaluationLibrarySyncIssue | undefined) => void>();
  let librarySyncIssue: EvaluationLibrarySyncIssue | undefined;
  const clientId = `evaluation-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  let eventSource: EventSource | undefined;

  type QueuedMutation = {
    before: EvaluationLibrary;
    mutation: EvaluationLibraryMutation;
    status: 'pending' | 'in-flight' | 'conflict' | 'failed';
    issueId?: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  const queuedMutations: QueuedMutation[] = [];
  let drainingMutations = false;
  let nextSyncIssueId = 0;

  // A refresh can start before a mutation and finish after it. Never let that
  // delayed read roll the local view back to an older server generation.
  const adoptLibrarySnapshot = (next: EvaluationLibrarySnapshot): EvaluationLibrarySnapshot => {
    if (!librarySnapshot || next.revision >= librarySnapshot.revision) librarySnapshot = next;
    return librarySnapshot;
  };

  const parseLibrarySnapshot = async (
    response: Response,
  ): Promise<EvaluationLibrarySnapshot> => {
    await requireOk(response);
    const value = (await response.json()) as Partial<EvaluationLibrarySnapshot>;
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) {
      throw new Error("Evaluation library response has an invalid revision.");
    }
    const library = options.normalizeLibrary(value.library);
    const resourceVersions = value.resourceVersions;
    const validVersions = hasCompleteResourceVersions(library, resourceVersions);
    return {
      revision: Number(value.revision),
      library,
      supportsResourceMutations: validVersions,
      resourceVersions: validVersions
        ? {
            suites: { ...resourceVersions.suites },
            datasets: { ...resourceVersions.datasets },
          }
        : { suites: {}, datasets: {} },
    };
  };

  const fetchLibrary = (): Promise<EvaluationLibrarySnapshot> =>
    fetch(url(options.baseUrl, "/library")).then(parseLibrarySnapshot);

  const initialize = (): Promise<EvaluationStoreInitialization | void> => {
    initializationPromise ??= (async () => {
      let warning: string | undefined;
      const legacySource = options.legacyLibrarySource;
      if (legacySource) {
        let legacyLibrary: EvaluationLibrary | undefined;
        try {
          await legacySource.initialize?.();
          legacyLibrary = await legacySource.getLibrary();
        } catch (error) {
          warning = `The existing browser evaluation library could not be migrated to server storage: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        if (legacyLibrary && hasLibraryContent(legacyLibrary)) {
          // A failed server import must fail initialization. Continuing would let
          // a later project save strip the only remaining legacy copy.
          adoptLibrarySnapshot(await fetch(
            url(options.baseUrl, "/library/import"),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ library: legacyLibrary }),
            },
          ).then(parseLibrarySnapshot));
        }
      }
      librarySnapshot ??= await fetchLibrary();
      optimisticLibrary ??= librarySnapshot.library;
      return warning ? { warning } : undefined;
    })();
    return initializationPromise;
  };

  const notifyLibraryListeners = () => {
    for (const listener of libraryListeners) listener();
  };

  const notifyLibrarySyncIssueListeners = () => {
    for (const listener of librarySyncIssueListeners) listener(librarySyncIssue);
  };

  const setLibrarySyncIssue = (issue: EvaluationLibrarySyncIssue | undefined) => {
    librarySyncIssue = issue;
    notifyLibrarySyncIssueListeners();
  };

  const resourceKind = (change: EvaluationLibraryMutationChange): EvaluationLibraryResourceKind =>
    change.kind.endsWith('suite') ? 'suite' : 'dataset';

  const desiredResourceValue = (change: EvaluationLibraryMutationChange): unknown => {
    if (change.kind === 'put-suite') return { suite: change.suite, baselines: change.baselines };
    if (change.kind === 'put-dataset') return change.dataset;
    return undefined;
  };

  const resourceEquals = evaluationLibraryValueEquals;

  const placeholderVersions = (library: EvaluationLibrary): EvaluationLibraryResourceVersions => ({
    suites: Object.fromEntries(library.data.suites.map((suite) => [suite.id, 'pending'])),
    datasets: Object.fromEntries(library.datasets.map((dataset) => [dataset.id, 'pending'])),
  });

  const mutationResourceKeys = (mutation: EvaluationLibraryMutation): Set<string> =>
    new Set(mutation.changes.map((change) => `${resourceKind(change)}:${change.id}`));

  const resourceKey = (kind: EvaluationLibraryResourceKind, id: string): string => `${kind}:${id}`;

  const isRetryableMutationFailure = (error: unknown): boolean =>
    error instanceof EvaluationLibraryRequestError ? error.retryable : error instanceof TypeError;

  const createIssueId = (kind: string) => `${kind}-${++nextSyncIssueId}`;

  const conflictDraftsFor = (
    group: QueuedMutation,
    conflicts: readonly EvaluationLibraryConflictResource[],
  ): EvaluationLibraryConflictDraft[] => {
    const snapshot = librarySnapshot!;
    return conflicts.map((conflict) => {
      // A field can change several times before the first request returns.
      // Show the author the newest retained intent, rather than an earlier
      // intermediate value that would be misleading to preserve as a copy.
      const localChange = [...queuedMutations]
        .reverse()
        .find(
          (candidate) =>
            (candidate === group || candidate.status === 'pending') &&
            candidate.mutation.changes.some(
              (change) => resourceKind(change) === conflict.kind && change.id === conflict.id,
            ),
        )
        ?.mutation.changes.find(
          (change) => resourceKind(change) === conflict.kind && change.id === conflict.id,
        );
      const local: EvaluationLibraryResourceValue = localChange
        ? conflict.kind === 'suite'
          ? {
              kind: 'suite',
              id: conflict.id,
              value:
                localChange.kind === 'put-suite'
                  ? { suite: localChange.suite, baselines: localChange.baselines }
                  : undefined,
            }
          : {
              kind: 'dataset',
              id: conflict.id,
              value: localChange.kind === 'put-dataset' ? localChange.dataset : undefined,
            }
        : getEvaluationLibraryResource(group.before, conflict.kind, conflict.id);
      return {
        ...conflict,
        local,
        server: getEvaluationLibraryResource(snapshot.library, conflict.kind, conflict.id),
      };
    });
  };

  const issueForFailure = (group: QueuedMutation, error: unknown): EvaluationLibrarySyncIssue => {
    if (error instanceof EvaluationLibraryResourceConflictError) {
      return {
        id: createIssueId('conflict'),
        kind: 'conflict',
        message: error.message,
        conflicts: conflictDraftsFor(group, error.conflicts),
      };
    }
    return {
      id: createIssueId(isRetryableMutationFailure(error) ? 'retry' : 'failed'),
      kind: isRetryableMutationFailure(error) ? 'retryable' : 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  };

  const rejectBlockedMutations = (source: QueuedMutation, error: unknown) => {
    const blocked = mutationResourceKeys(source.mutation);
    for (const candidate of queuedMutations) {
      if (
        candidate === source ||
        candidate.status !== 'pending' ||
        !candidate.mutation.changes.some((change) => blocked.has(`${resourceKind(change)}:${change.id}`))
      ) {
        continue;
      }
      // Keep the local overlay intact after a conflict, but never leave a
      // later save promise waiting behind it. The user must explicitly reload
      // and reconcile the resource before a new save can be attempted.
      candidate.status = error instanceof EvaluationLibraryResourceConflictError ? 'conflict' : 'failed';
      candidate.issueId = source.issueId;
      candidate.reject(error);
    }
  };

  const rebuildOptimisticLibrary = () => {
    if (!librarySnapshot) return;
    let library = librarySnapshot.library;
    for (const group of queuedMutations) {
      library = applyEvaluationLibraryMutation(library, group.mutation);
    }
    optimisticLibrary = library;
    notifyLibraryListeners();
  };

  const prepareMutation = (group: QueuedMutation): EvaluationLibraryMutation => {
    const snapshot = librarySnapshot!;
    const conflicts: EvaluationLibraryConflictResource[] = [];
    const changes: EvaluationLibraryMutationChange[] = [];
    for (const change of group.mutation.changes) {
      const kind = resourceKind(change);
      const before = getEvaluationLibraryResource(group.before, kind, change.id).value;
      const current = getEvaluationLibraryResource(snapshot.library, kind, change.id).value;
      const desired = desiredResourceValue(change);
      if (resourceEquals(current, desired)) continue;
      if (!resourceEquals(current, before)) {
        const currentVersion =
          kind === 'suite'
            ? snapshot.resourceVersions.suites[change.id] ?? null
            : snapshot.resourceVersions.datasets[change.id] ?? null;
        conflicts.push({
          kind,
          id: change.id,
          expectedVersion: before === undefined ? null : currentVersion,
          currentVersion,
        });
        continue;
      }
      const currentVersion =
        kind === 'suite'
          ? snapshot.resourceVersions.suites[change.id]
          : snapshot.resourceVersions.datasets[change.id];
      if (before !== undefined && !currentVersion) {
        throw new Error(`The ${kind} "${change.id}" is missing its collaboration version.`);
      }
      const expectedVersion = before === undefined ? null : currentVersion!;
      changes.push({ ...change, expectedVersion } as EvaluationLibraryMutationChange);
    }
    if (conflicts.length > 0) {
      throw new EvaluationLibraryResourceConflictError({
        message: 'This evaluation resource changed in another browser. Review the conflict before saving it again.',
        conflicts,
        snapshot,
      });
    }
    return { changes };
  };

  const parseMutationResponse = async (response: Response): Promise<EvaluationLibrarySnapshot> => {
    if (response.status !== 409) return parseLibrarySnapshot(response);
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
      conflicts?: unknown;
      snapshot?: unknown;
    } | null;
    const conflicts = Array.isArray(body?.conflicts)
      ? body.conflicts.filter(
          (value): value is EvaluationLibraryConflictResource =>
            typeof value === 'object' &&
            value !== null &&
            ((value as { kind?: unknown }).kind === 'suite' || (value as { kind?: unknown }).kind === 'dataset') &&
            typeof (value as { id?: unknown }).id === 'string',
        )
      : [];
    if (conflicts.length === 0) {
      // The resource route promises structured conflicts. If a proxy or an
      // older server returns a bare 409 instead, do not present a conflict
      // dialog with no resource to resolve. Keep the edit as a retryable
      // recovery state; retry refreshes the snapshot and can then surface a
      // normal resource conflict when one is actually present.
      throw new Error(
        typeof body?.error === 'string'
          ? `${body.error} Retry the save to refresh the shared evaluation library.`
          : 'The server returned an incomplete evaluation-library conflict. Retry the save to refresh the shared evaluation library.',
      );
    }
    let snapshot: EvaluationLibrarySnapshot | undefined;
    if (body?.snapshot && typeof body.snapshot === 'object') {
      const encoded = Response.json(body.snapshot);
      snapshot = await parseLibrarySnapshot(encoded);
    }
    throw new EvaluationLibraryResourceConflictError({
      message:
        typeof body?.error === 'string'
          ? body.error
          : 'This evaluation resource changed in another browser.',
      conflicts,
      snapshot,
    });
  };

  const drainMutations = async (): Promise<void> => {
    if (drainingMutations) return;
    drainingMutations = true;
    try {
      while (true) {
        const group = queuedMutations.find((candidate) => candidate.status === 'pending');
        if (!group) return;
        group.status = 'in-flight';
        try {
          const mutation = prepareMutation(group);
          if (mutation.changes.length === 0) {
            queuedMutations.splice(queuedMutations.indexOf(group), 1);
            group.resolve();
            rebuildOptimisticLibrary();
            continue;
          }
          adoptLibrarySnapshot(await fetch(url(options.baseUrl, '/library/mutations'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [EVALUATION_LIBRARY_CLIENT_ID_HEADER]: clientId,
            },
            body: JSON.stringify(mutation),
          }).then(parseMutationResponse));
          queuedMutations.splice(queuedMutations.indexOf(group), 1);
          group.resolve();
          rebuildOptimisticLibrary();
        } catch (error) {
          if (error instanceof EvaluationLibraryResourceConflictError) {
            if (error.snapshot) {
              // A conflict response comes from the resource-mutation route,
              // so it necessarily supports the resource-token protocol.
              adoptLibrarySnapshot({ ...error.snapshot, supportsResourceMutations: true });
            }
            group.status = 'conflict';
          } else {
            group.status = 'failed';
          }
          const issue = issueForFailure(group, error);
          group.issueId = issue.id;
          setLibrarySyncIssue(issue);
          group.reject(error);
          rejectBlockedMutations(group, error);
          rebuildOptimisticLibrary();
          // An unresolved failure is deliberately a queue barrier. Continuing
          // with an unrelated pending mutation can create a second issue and
          // replace the first dialog, leaving the earlier local edit with no
          // route to resolution. The user action below resumes the queue.
          return;
        }
      }
    } finally {
      drainingMutations = false;
    }
  };

  const removeQueuedMutation = (group: QueuedMutation) => {
    const index = queuedMutations.indexOf(group);
    if (index !== -1) queuedMutations.splice(index, 1);
  };

  const allocateCopyId = (kind: EvaluationLibraryResourceKind, id: string): string => {
    const existing = new Set<string>(
      kind === 'suite'
        ? librarySnapshot!.library.data.suites.map((suite) => suite.id)
        : librarySnapshot!.library.datasets.map((dataset) => dataset.id),
    );
    for (const group of queuedMutations) {
      for (const change of group.mutation.changes) {
        if (resourceKind(change) === kind && !change.kind.startsWith('delete-')) existing.add(change.id);
      }
    }
    let suffix = 2;
    let candidate = `${id}-copy`;
    while (existing.has(candidate)) candidate = `${id}-copy-${suffix++}`;
    return candidate;
  };

  const allocateCopiedBaselineId = (id: string): string => {
    const existing = new Set<string>(librarySnapshot!.library.data.baselines.map((baseline) => baseline.id));
    for (const group of queuedMutations) {
      for (const change of group.mutation.changes) {
        if (change.kind === 'put-suite') {
          for (const baseline of change.baselines) existing.add(baseline.id);
        }
      }
    }
    let suffix = 2;
    let candidate = `${id}-copy`;
    while (existing.has(candidate)) candidate = `${id}-copy-${suffix++}`;
    return candidate;
  };

  const copyChange = (
    change: EvaluationLibraryMutationChange,
    copyId: string,
  ): EvaluationLibraryMutationChange => {
    if (change.kind === 'put-suite') {
      return {
        ...change,
        id: copyId,
        expectedVersion: null,
        suite: { ...change.suite, id: copyId, name: `${change.suite.name || 'Untitled evaluation suite'} (copy)` },
        baselines: change.baselines.map((baseline) => ({
          ...baseline,
          id: allocateCopiedBaselineId(baseline.id),
          suiteId: copyId,
        })),
      };
    }
    if (change.kind === 'put-dataset') {
      return {
        ...change,
        id: copyId,
        expectedVersion: null,
        dataset: { ...change.dataset, id: copyId, name: `${change.dataset.name || 'Untitled evaluation dataset'} (copy)` },
      };
    }
    throw new Error('A deletion has no local value to keep as a copy. Use the server version or edit it again after reloading.');
  };

  const resolveLibraryConflict = async (input: EvaluationLibraryConflictResolution): Promise<EvaluationLibrary> => {
    await initialize();
    const issue = librarySyncIssue;
    if (!issue || issue.id !== input.issueId || issue.kind !== 'conflict') {
      throw new Error('This evaluation-library conflict is no longer pending.');
    }
    const conflict = issue.conflicts.find(
      (candidate) => candidate.kind === input.kind && candidate.id === input.id,
    );
    if (!conflict) throw new Error('The selected evaluation-library resource is not part of this conflict.');

    const matchingGroups = queuedMutations.filter(
      (group) =>
        group.issueId === issue.id &&
        group.mutation.changes.some((change) => resourceKey(resourceKind(change), change.id) === resourceKey(input.kind, input.id)),
    );
    if (matchingGroups.length === 0) throw new Error('The local change for this conflict is no longer available.');

    if (input.action === 'keep-mine-as-copy' && conflict.local.value === undefined) {
      throw new Error('A deleted resource cannot be kept as a copy. Use the server version, then make a new deletion if it is still needed.');
    }

    const copyId = input.action === 'keep-mine-as-copy' ? allocateCopyId(input.kind, input.id) : undefined;
    // Retain only the newest local edit for a copied resource. Earlier edits
    // describe intermediate states; replaying each one under the same fresh
    // ID would either overwrite the copy or trigger a second false conflict.
    const copyGroup = copyId ? matchingGroups.at(-1) : undefined;
    for (const group of matchingGroups) {
      const changes = group.mutation.changes.flatMap((change) => {
        if (resourceKey(resourceKind(change), change.id) !== resourceKey(input.kind, input.id)) return [change];
        if (input.action === 'use-server' || group !== copyGroup) return [];
        return [copyChange(change, copyId!)];
      });
      // A local suite created alongside a copied dataset should follow that
      // copy. Existing server suites remain untouched: copying is explicit
      // and never mutates another editor's resources.
      group.mutation = {
        changes:
          copyId && input.kind === 'dataset'
            ? changes.map((change) =>
                change.kind === 'put-suite' &&
                getEvaluationLibraryResource(group.before, 'suite', change.id).value === undefined &&
                change.suite.datasetId === input.id
                  ? { ...change, suite: { ...change.suite, datasetId: copyId } }
                  : change,
              )
            : changes,
      };
      group.issueId = undefined;
      if (group.mutation.changes.length === 0) removeQueuedMutation(group);
      else group.status = 'pending';
    }

    setLibrarySyncIssue(undefined);
    rebuildOptimisticLibrary();
    await drainMutations();
    return structuredClone(optimisticLibrary ?? librarySnapshot!.library);
  };

  const retryLibrarySync = async (): Promise<EvaluationLibrary> => {
    await initialize();
    const issue = librarySyncIssue;
    if (!issue || (issue.kind !== 'retryable' && issue.kind !== 'failed')) {
      throw new Error('There is no failed evaluation-library save pending.');
    }
    const groups = queuedMutations.filter((group) => group.issueId === issue.id && group.status === 'failed');
    if (groups.length === 0) throw new Error('The retryable evaluation-library save is no longer pending.');
    // Refresh before requeueing. Besides avoiding a redundant write after a
    // transient response failure, this converts a malformed/bare 409 into a
    // proper current-resource conflict instead of trapping the user behind a
    // dialog with no actionable resource.
    adoptLibrarySnapshot(await fetchLibrary());
    for (const group of groups) {
      group.status = 'pending';
      group.issueId = undefined;
    }
    setLibrarySyncIssue(undefined);
    rebuildOptimisticLibrary();
    await drainMutations();
    return structuredClone(optimisticLibrary ?? librarySnapshot!.library);
  };

  const refreshLibrarySnapshot = async (): Promise<EvaluationLibrarySnapshot> => {
    await initialize();
    const snapshot = adoptLibrarySnapshot(await fetchLibrary());
    rebuildOptimisticLibrary();
    return structuredClone(snapshot);
  };

  const startEventStream = () => {
    if (eventSource || typeof EventSource === 'undefined') return;
    eventSource = new EventSource(url(options.baseUrl, '/library/events'));
    const onChange = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as { sourceClientId?: unknown };
        if (value.sourceClientId === clientId) return;
      } catch {
        return;
      }
      notifyLibraryListeners();
    };
    eventSource.addEventListener('library-state', onChange);
    eventSource.addEventListener('library-changed', onChange);
  };

  const stopEventStream = () => {
    if (!eventSource || libraryListeners.size > 0) return;
    eventSource.close();
    eventSource = undefined;
  };

  return {
    initialize,
    async getLibrary() {
      await initialize();
      return structuredClone(optimisticLibrary ?? librarySnapshot!.library);
    },
    getLibrarySyncSnapshot: refreshLibrarySnapshot,
    mutateLibrary: async (mutation) => {
      await initialize();
      const response = await fetch(url(options.baseUrl, '/library/mutations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [EVALUATION_LIBRARY_CLIENT_ID_HEADER]: clientId },
        body: JSON.stringify(mutation),
      });
      const snapshot = await parseMutationResponse(response);
      adoptLibrarySnapshot(snapshot);
      rebuildOptimisticLibrary();
      return structuredClone(librarySnapshot!);
    },
    subscribeLibraryInvalidation(listener) {
      libraryListeners.add(listener);
      startEventStream();
      return () => {
        libraryListeners.delete(listener);
        stopEventStream();
      };
    },
    subscribeLibrarySyncIssue(listener) {
      librarySyncIssueListeners.add(listener);
      listener(librarySyncIssue);
      return () => {
        librarySyncIssueListeners.delete(listener);
      };
    },
    resolveLibraryConflict,
    retryLibrarySync,
    async putLibrary(library) {
      await initialize();
      const next = structuredClone(library);
      const before = optimisticLibrary ?? librarySnapshot!.library;
      const migrationMetadataChanged =
        JSON.stringify(before.migratedLegacyProjectIds) !== JSON.stringify(next.migratedLegacyProjectIds);
      const mutation = diffEvaluationLibraryMutation(before, next, placeholderVersions(before));
      if (!mutation && !migrationMetadataChanged) return;
      if (!librarySnapshot!.supportsResourceMutations || migrationMetadataChanged) {
        // Migration metadata is a library-level idempotency record, not a
        // suite or dataset resource. Preserve it with the legacy guarded
        // replacement path until it has its own server operation. This only
        // runs for a real legacy-project migration, never on ordinary load.
        const write = legacyLibraryWrite
          .catch(() => undefined)
          .then(async () => {
            adoptLibrarySnapshot(await fetch(url(options.baseUrl, '/library'), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', [EVALUATION_LIBRARY_CLIENT_ID_HEADER]: clientId },
              body: JSON.stringify({ expectedRevision: librarySnapshot!.revision, library: next }),
            }).then(parseLibrarySnapshot));
            optimisticLibrary = librarySnapshot!.library;
            notifyLibraryListeners();
          });
        legacyLibraryWrite = write;
        await write;
        return;
      }
      if (!mutation) return;
      optimisticLibrary = next;
      const write = new Promise<void>((resolve, reject) => {
        queuedMutations.push({ before, mutation, status: 'pending', resolve, reject });
      });
      void drainMutations();
      await write;
    },
    async put(run) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(run.id)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: run.projectId, run }),
        },
      );
      await requireOk(response);
    },
    async updateRunName(input) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: input.projectId,
            ...(input.name === undefined ? {} : { name: input.name }),
          }),
        },
      );
      if (response.status === 404) return undefined;
      await requireOk(response);
      return options.normalizeRun(await response.json());
    },
    async get(input) {
      const requestUrl = new URL(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return options.normalizeRun(await response.json());
    },
    async list(input) {
      const requestUrl = new URL(url(options.baseUrl), window.location.origin);
      requestUrl.searchParams.set("projectId", String(input.projectId));
      if (input.suiteId != null)
        requestUrl.searchParams.set("suiteId", input.suiteId);
      const response = await fetch(requestUrl);
      await requireOk(response);
      const runs: unknown = await response.json();
      if (!Array.isArray(runs))
        throw new Error("Evaluation run history response must be an array.");
      return runs.map(options.normalizeRun);
    },
    async delete(input) {
      const response = await fetch(
        url(options.baseUrl, `/${encodeURIComponent(input.runId)}`),
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
    },
    async putDatasetSnapshot(snapshot) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/datasets/${encodeURIComponent(snapshot.fingerprint)}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        },
      );
      await requireOk(response);
    },
    async getDatasetSnapshot(input) {
      const requestUrl = new URL(
        url(
          options.baseUrl,
          `/datasets/${encodeURIComponent(input.fingerprint)}`,
        ),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return response.json() as Promise<EvaluationDatasetSnapshot>;
    },
    async putRecording(artifact) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(artifact.reference.id)}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(artifact),
        },
      );
      await requireOk(response);
    },
    async getRecording(input) {
      const requestUrl = new URL(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(input.recordingId)}`,
        ),
        window.location.origin,
      );
      requestUrl.searchParams.set("projectId", String(input.projectId));
      const response = await fetch(requestUrl);
      if (response.status === 404) return undefined;
      await requireOk(response);
      return response.json() as Promise<EvaluationRecordingArtifact>;
    },
    async updateRecordingRetention(input) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/recordings/${encodeURIComponent(input.recordingId)}`,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
      const payload = (await response.json()) as { updated?: unknown };
      if (typeof payload.updated !== "boolean") {
        throw new Error("The Evaluation recording retention response is invalid.");
      }
      return payload.updated;
    },
    async promoteBaseline(input) {
      const response = await fetch(
        url(
          options.baseUrl,
          `/${encodeURIComponent(input.runId)}/promote-baseline`,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      await requireOk(response);
    },
    async applyRunEvent(event: EvaluationRunEvent) {
      const runId = event.type === "trial-settled" ? event.runId : event.run.id;
      const response = await fetch(
        url(options.baseUrl, `/events/${encodeURIComponent(runId)}`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        },
      );
      await requireOk(response);
    },
  };
}
