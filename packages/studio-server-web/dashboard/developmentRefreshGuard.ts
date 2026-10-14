export type DevelopmentWorkspaceSafety = {
  dirty: boolean;
  busy: boolean;
  recoverySaved: boolean;
  reloadAvailable: boolean;
};

/** Unknown recovery or activity never becomes permission to reload. */
export const canRefreshDevelopmentWorkspace = (state: DevelopmentWorkspaceSafety): boolean =>
  !state.dirty && !state.busy && state.recoverySaved && state.reloadAvailable;

/** The current view is live; only inactive projects use retained snapshots. */
export const hasDevelopmentProjectRuns = (
  activeProjectId: string | undefined,
  activeRunning: boolean,
  snapshots: Record<string, { graphRunning: boolean } | undefined>,
): boolean =>
  activeRunning ||
  Object.entries(snapshots).some(([id, snapshot]) => id !== activeProjectId && snapshot?.graphRunning === true);

export const getDevelopmentGeneration = (): string | null =>
  document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')?.content ?? null;

export type DevelopmentRefreshWindow = Window & {
  __rivetDevelopmentRefreshReady?: (requestId: string) => boolean;
};
