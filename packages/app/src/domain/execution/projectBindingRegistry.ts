export type ProjectBinding = Readonly<{ token: number; path?: string | null; bundleKey?: string }>;
export type ProjectBindingSpec = Omit<ProjectBinding, 'token'>;

/** Workspace-local runtime identities. Tokens are never persisted or recycled. */
export function createProjectBindingRegistry() {
  let serial = 0;
  let workspaceToken = 0;
  const bindings = new Map<string, ProjectBinding>();
  return {
    reconcile(opened: Record<string, ProjectBindingSpec>) {
      for (const id of bindings.keys()) if (!opened[id]) bindings.delete(id);
      for (const [id, spec] of Object.entries(opened)) {
        const old = bindings.get(id);
        if (!old || old.path !== spec.path || old.bundleKey !== spec.bundleKey)
          bindings.set(id, Object.freeze({ ...spec, token: ++serial }));
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
