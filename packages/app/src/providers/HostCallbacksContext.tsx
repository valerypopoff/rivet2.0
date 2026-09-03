import { createContext, useContext, useMemo, type FC, type ReactNode } from 'react';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';

export type RivetAppHostProjectSavedEvent = {
  project: Omit<Project, 'data'>;
  /** The save completed, but a newer local snapshot is still dirty. */
  hasNewerUnsavedChanges?: boolean;
  /** The originating tab path changed before this save completed. */
  pathChangedWhileSaving?: boolean;
  path: string | null;
  saveAs: boolean;
};

export type RivetAppHostActiveProjectChangedEvent = {
  project: Omit<Project, 'data'> | null;
  projectId: ProjectId | null;
  path: string | null;
};

export type RivetAppHostOpenProjectCountChangedEvent = {
  count: number;
  projectIds: ProjectId[];
};

export type RivetAppHostOpenErrorEvent = {
  error: unknown;
  operation: 'loadProject' | 'openProjectSnapshot' | 'openProjectPath';
  path?: string | null;
  projectId?: ProjectId;
  openedGraph?: GraphId;
};

export type RivetAppHostCallbacks = {
  onProjectSaved?: (event: RivetAppHostProjectSavedEvent) => void;
  onActiveProjectChanged?: (event: RivetAppHostActiveProjectChangedEvent) => void;
  onOpenProjectCountChanged?: (event: RivetAppHostOpenProjectCountChangedEvent) => void;
  onOpenError?: (event: RivetAppHostOpenErrorEvent) => void;
};

const HostCallbacksContext = createContext<RivetAppHostCallbacks>({});

export const HostCallbacksProvider: FC<{ callbacks?: RivetAppHostCallbacks; children: ReactNode }> = ({
  callbacks,
  children,
}) => {
  const value = useMemo(() => callbacks ?? {}, [callbacks]);
  return <HostCallbacksContext.Provider value={value}>{children}</HostCallbacksContext.Provider>;
};

export function useRivetAppHostCallbacks(): RivetAppHostCallbacks {
  return useContext(HostCallbacksContext);
}
