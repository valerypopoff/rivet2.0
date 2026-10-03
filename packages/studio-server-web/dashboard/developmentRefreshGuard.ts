export type DevelopmentWorkspaceSafety = {
  dirty: boolean;
  busy: boolean;
  recoverySaved: boolean;
  reloadAvailable: boolean;
};

/** Unknown recovery or activity never becomes permission to reload. */
export const canRefreshDevelopmentWorkspace = (state: DevelopmentWorkspaceSafety): boolean =>
  !state.dirty && !state.busy && state.recoverySaved && state.reloadAvailable;

export const getDevelopmentGeneration = (): string | null =>
  document.querySelector<HTMLMetaElement>('meta[name="rivet-dev-generation"]')?.content ?? null;

export type DevelopmentRefreshWindow = Window & {
  __rivetDevelopmentRefreshReady?: (requestId: string) => boolean;
};
