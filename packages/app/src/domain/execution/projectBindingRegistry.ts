export type ProjectBinding = Readonly<{ token: number; path?: string | null; bundleKey?: string }>;
export type ProjectBindingSpec = Omit<ProjectBinding, 'token'>;
export type VerifiedProjectPathMove = Readonly<{ from: string; to: string }>;

function pathCounts(specs: Iterable<ProjectBindingSpec>) {
  const counts = new Map<string, number>();
  for (const { path } of specs) if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  return counts;
}

/** Workspace-local runtime identities. Tokens are never persisted or recycled. */
export function createProjectBindingRegistry() {
  let serial = 0;
  let workspaceToken = 0;
  const bindings = new Map<string, ProjectBinding>();
  return {
    reconcile(
      opened: Record<string, ProjectBindingSpec>,
      verifiedMoves?: ReadonlyMap<string, VerifiedProjectPathMove>,
    ) {
      const beforePaths = verifiedMoves?.size ? pathCounts(bindings.values()) : undefined;
      const afterPaths = verifiedMoves?.size ? pathCounts(Object.values(opened)) : undefined;
      for (const id of bindings.keys()) if (!Object.hasOwn(opened, id)) bindings.delete(id);
      for (const [id, spec] of Object.entries(opened)) {
        const old = bindings.get(id);
        if (!old || old.path !== spec.path || old.bundleKey !== spec.bundleKey) {
          const move = verifiedMoves?.get(id);
          // Only an explicit same-document rename may update the descriptor
          // without a new lifetime. Ambiguous paths and membership changes
          // retain the ordinary fail-closed rebind behavior.
          const renamed =
            old &&
            move?.from &&
            move.to &&
            old.path === move.from &&
            spec.path === move.to &&
            old.bundleKey === spec.bundleKey &&
            beforePaths?.get(move.from) === 1 &&
            afterPaths?.get(move.to) === 1;
          bindings.set(id, Object.freeze({ ...spec, token: renamed ? old.token : ++serial }));
        }
      }
    },
    renew(id: string) {
      const old = bindings.get(id);
      if (old) bindings.set(id, Object.freeze({ ...old, token: ++serial }));
    },
    get: (id: string) => bindings.get(id),
    getWorkspaceToken: () => workspaceToken,
    invalidateWorkspace() {
      workspaceToken++;
      // Keep open descriptors available for a remounted view, but no old event
      // may inherit their lifetimes merely because the store was retained.
      for (const [id, binding] of bindings) bindings.set(id, Object.freeze({ ...binding, token: ++serial }));
    },
    capture: () => new Map(bindings),
    isCurrent: (id: string, token: number) => bindings.get(id)?.token === token,
    dispose() {
      workspaceToken++;
      bindings.clear();
    },
  };
}
