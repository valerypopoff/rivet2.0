import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import type { FC } from 'react';
import type { NodeGraph, UiGraph } from '@valerypopoff/rivet2-core';
import { AppModalHeader } from '../AppModalHeader.js';
import { GraphInfoModal } from '../GraphInfoModal.js';
import { ProjectInfoModal } from '../ProjectInfoModal.js';

const confirmBody = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const GraphListDialogs: FC<{
  graphPendingDelete: NodeGraph | null;
  graphPendingInfo: NodeGraph | null;
  isProjectInfoOpen: boolean;
  onCloseGraphDelete(): void;
  onCloseGraphInfo(): void;
  onCloseProjectInfo(): void;
  onCloseUiGraphDelete(): void;
  onConfirmGraphDelete(): void;
  onConfirmUiGraphDelete(): void;
  onUpdateGraphInfo(graph: NodeGraph): void;
  uiGraphPendingDelete: UiGraph | null;
}> = ({
  graphPendingDelete,
  graphPendingInfo,
  isProjectInfoOpen,
  onCloseGraphDelete,
  onCloseGraphInfo,
  onCloseProjectInfo,
  onCloseUiGraphDelete,
  onConfirmGraphDelete,
  onConfirmUiGraphDelete,
  onUpdateGraphInfo,
  uiGraphPendingDelete,
}) => (
  <>
    <DeleteResourceConfirmModal
      isOpen={graphPendingDelete != null}
      resourceName={graphPendingDelete?.metadata?.name ?? 'Untitled graph'}
      title="Delete Graph?"
      onClose={onCloseGraphDelete}
      onConfirm={onConfirmGraphDelete}
    />
    <DeleteResourceConfirmModal
      isOpen={uiGraphPendingDelete != null}
      resourceName={uiGraphPendingDelete?.name ?? 'Untitled web app'}
      title="Delete Web App?"
      onClose={onCloseUiGraphDelete}
      onConfirm={onConfirmUiGraphDelete}
    />
    <GraphInfoModal graph={graphPendingInfo} onChange={onUpdateGraphInfo} onClose={onCloseGraphInfo} />
    <ProjectInfoModal isOpen={isProjectInfoOpen} onClose={onCloseProjectInfo} />
  </>
);

const DeleteResourceConfirmModal: FC<{
  isOpen: boolean;
  onClose(): void;
  onConfirm(): void;
  resourceName: string;
  title: string;
}> = ({ isOpen, onClose, onConfirm, resourceName, title }) => (
  <ModalTransition>
    {isOpen && (
      <Modal autoFocus={false} onClose={onClose} width="small">
        <AppModalHeader title={title} onClose={onClose} />
        <ModalBody>
          <div css={confirmBody}>
            <p>
              Delete <strong>{resourceName}</strong>?
            </p>
            <p>This cannot be undone.</p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button appearance="danger" onClick={onConfirm}>
            Delete
          </Button>
        </ModalFooter>
      </Modal>
    )}
  </ModalTransition>
);
