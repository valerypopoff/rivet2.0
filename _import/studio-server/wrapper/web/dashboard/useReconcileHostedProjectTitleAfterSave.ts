import { useCallback } from 'react';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { RivetAppHostProjectSavedEvent, RivetWorkspaceHost } from '../../../rivet/packages/app/src/host';
import { flushHybridStorageGroup } from '../../../rivet/packages/app/src/state/storage';
import { resolveHostedProjectTitleFromPath } from './openedProjectMetadata';

export function useReconcileHostedProjectTitleAfterSave(workspaceHost: RivetWorkspaceHost | null) {
  return useCallback((event: RivetAppHostProjectSavedEvent) => {
    const projectId = event.project.metadata.id as ProjectId | undefined;
    const title = resolveHostedProjectTitleFromPath(event.path);
    if (!workspaceHost || !projectId || !title) {
      return;
    }

    void (async () => {
      const updated = await workspaceHost.updateProjectMetadata(
        projectId,
        { title },
        {
          path: event.path,
          persistedExternally: true,
        },
      );

      if (updated) {
        await flushHybridStorageGroup('project');
      }
    })().catch((error) => {
      console.error('Failed to reconcile hosted project title after save:', error);
    });
  }, [workspaceHost]);
}
