import { type FC } from 'react';
import { InlineEditableTextfield } from '@atlaskit/inline-edit';
import { type NodeGraph } from '@valerypopoff/rivet2-core';
import { GraphRevisions } from './GraphRevisionList';
import { css } from '@emotion/react';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import Button from '@atlaskit/button';
import { AppModalHeader } from './AppModalHeader.js';

const styles = css`
  font-size: var(--ui-font-size-compact);

  label,
  .graph-info-label,
  [data-read-view-fit-container-width] > div,
  input {
    font-size: var(--ui-font-size-compact) !important;
  }

  .graph-info-layout {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .graph-info-item {
    min-width: 0;
    margin: 0 0 16px;

    > * {
      margin-top: 0 !important;
    }

    > form {
      margin: 0;
    }

    > form > div {
      margin-top: 0 !important;
    }
  }

  .graph-info-label {
    color: var(--foreground-muted);
    font-weight: var(--font-weight-semibold);
    margin-bottom: 6px;
  }
`;

export const GraphInfoPanel: FC<{
  graph: NodeGraph;
  onChange: (graph: NodeGraph) => void;
}> = ({ graph, onChange }) => {
  return (
    <div css={styles} className="graph-info-section">
      <div className="graph-info-layout">
        <div className="graph-info-item">
          <InlineEditableTextfield
            key={`graph-name-${graph.metadata?.id}`}
            label="Graph Name"
            placeholder="Graph Name"
            onConfirm={(newValue) =>
              onChange({ ...graph, metadata: { ...graph.metadata, name: newValue } })
            }
            defaultValue={graph.metadata?.name ?? 'Untitled graph'}
            readViewFitContainerWidth
          />
        </div>
        <div className="graph-info-item">
          <InlineEditableTextfield
            key={`graph-description-${graph.metadata?.id}`}
            label="Description"
            placeholder="Graph Description"
            defaultValue={graph.metadata?.description ?? ''}
            onConfirm={(newValue) =>
              onChange({ ...graph, metadata: { ...graph.metadata, description: newValue } })
            }
            readViewFitContainerWidth
          />
        </div>
        <div className="graph-info-item">
          <div className="graph-info-label">Revisions</div>
          <GraphRevisions graphId={graph.metadata?.id} />
        </div>
      </div>
    </div>
  );
};

export const GraphInfoModal: FC<{
  graph: NodeGraph | null;
  onChange: (graph: NodeGraph) => void;
  onClose: () => void;
}> = ({ graph, onChange, onClose }) => {
  return (
    <ModalTransition>
      {graph && (
        <Modal onClose={onClose}>
          <AppModalHeader title="Graph info" onClose={onClose} />
          <ModalBody>
            <GraphInfoPanel graph={graph} onChange={onChange} />
          </ModalBody>
          <ModalFooter>
            <Button appearance="primary" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
