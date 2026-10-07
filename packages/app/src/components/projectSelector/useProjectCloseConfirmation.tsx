import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { type ProjectId } from '@valerypopoff/rivet2-core';
import { useAtomValue, useStore } from 'jotai';
import { type FC, useEffect, useState } from 'react';

import { useRivetWorkspaceHost } from '../../hooks/useRivetWorkspaceHost.js';
import {
  openedProjectsState,
  projectDataUnsavedChangesState,
  projectUnsavedChangesState,
  projectState,
  openedProjectSnapshotsState,
  savedProjectContentDigestsState,
} from '../../state/savedGraphs.js';
import {
  hasProjectUnsavedChanges,
  buildCurrentProjectContentSnapshot,
  hasProjectContentChangedFromCleanDigest,
} from '../../utils/projectUnsavedChanges.js';
import { graphState } from '../../state/graph.js';
import { AppModalHeader } from '../AppModalHeader.js';

const unsavedProjectCloseModalBody = css`
  display: flex;
  flex-direction: column;
  gap: 8px;

  p {
    margin: 0;
  }
`;

export function useProjectCloseConfirmation(): {
  closeConfirmModal: JSX.Element;
  requestCloseProject: (projectId: ProjectId) => void;
} {
  const openedProjects = useAtomValue(openedProjectsState);
  const store = useStore();
  const { closeProject } = useRivetWorkspaceHost();
  const [projectPendingClose, setProjectPendingClose] = useState<ProjectId | null>(null);

  const requestCloseProject = (projectId: ProjectId) => {
    const active = store.get(projectState);
    const content =
      active.metadata.id === projectId
        ? buildCurrentProjectContentSnapshot({ project: active, graph: store.get(graphState) })
        : store.get(openedProjectSnapshotsState)[projectId];
    const digests = store.get(savedProjectContentDigestsState);
    if (
      (store.get(openedProjectsState)[projectId] != null && digests[projectId] == null) ||
      hasProjectUnsavedChanges(
        store.get(projectUnsavedChangesState),
        store.get(projectDataUnsavedChangesState),
        projectId,
      ) ||
      hasProjectContentChangedFromCleanDigest(digests, content)
    ) {
      setProjectPendingClose(projectId);
      return;
    }

    void closeProject(projectId);
  };

  const cancelCloseProject = () => setProjectPendingClose(null);

  const confirmCloseProject = () => {
    const projectId = projectPendingClose;
    if (!projectId) {
      return;
    }

    setProjectPendingClose(null);
    void closeProject(projectId);
  };

  const projectPendingCloseInfo = projectPendingClose ? openedProjects[projectPendingClose] : undefined;

  useEffect(() => {
    if (projectPendingClose && !projectPendingCloseInfo) {
      setProjectPendingClose(null);
    }
  }, [projectPendingClose, projectPendingCloseInfo]);

  const closeConfirmModal = (
    <UnsavedProjectCloseConfirmModal
      projectTitle={projectPendingCloseInfo?.title}
      onClose={cancelCloseProject}
      onConfirm={confirmCloseProject}
      open={projectPendingCloseInfo != null}
    />
  );

  return { closeConfirmModal, requestCloseProject };
}

const UnsavedProjectCloseConfirmModal: FC<{
  open: boolean;
  projectTitle?: string;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ open, projectTitle, onClose, onConfirm }) => (
  <ModalTransition>
    {open && (
      <Modal autoFocus={false} onClose={onClose} width="small">
        <AppModalHeader title="Unsaved changes" onClose={onClose} />
        <ModalBody>
          <div css={unsavedProjectCloseModalBody}>
            <p>
              There are unsaved changes in <strong>{projectTitle ?? 'this project'}</strong>.
            </p>
            <p>Close this project tab anyway? Unsaved changes will be lost.</p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button appearance="danger" onClick={onConfirm}>
            Close without saving
          </Button>
        </ModalFooter>
      </Modal>
    )}
  </ModalTransition>
);
