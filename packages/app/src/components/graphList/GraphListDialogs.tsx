import type { FC } from 'react';
import type { NodeGraph, UiGraph } from '@valerypopoff/rivet2-core';
import { DeleteResourceConfirmModal } from '../DeleteResourceConfirmModal.js';
import { GraphInfoModal } from '../GraphInfoModal.js';
import { ProjectInfoModal } from '../ProjectInfoModal.js';
import { GraphDeleteConfirmModal } from './GraphDeleteConfirmModal.js';
import type { GraphDeletionRequest } from './graphDeletion.js';

export const GraphListDialogs: FC<{
  graphPendingDelete: GraphDeletionRequest | null;
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
    {graphPendingDelete && (
      <GraphDeleteConfirmModal
        key={`${graphPendingDelete.projectId}/${graphPendingDelete.folderPath ?? graphPendingDelete.graphIds.join(',')}`}
        request={graphPendingDelete}
        onClose={onCloseGraphDelete}
        onConfirm={onConfirmGraphDelete}
      />
    )}
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
