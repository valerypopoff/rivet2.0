import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import { useAtom } from 'jotai';
import type { FC } from 'react';
import { useDeleteNodesCommand } from '../commands/deleteNodeCommand';
import { deleteGraphInputConfirmState } from '../state/ui';
import { AppModalHeader } from './AppModalHeader';

const modalBody = css`
  color: var(--foreground);
  font-size: var(--ui-font-size-compact);

  p {
    margin: 0 0 12px;
  }

  ul {
    max-height: 180px;
    margin: 8px 0 0;
    padding-left: 18px;
    overflow: auto;
  }

  li + li {
    margin-top: 4px;
  }
`;

export const DeleteGraphInputConfirmModalRenderer: FC = () => {
  const [confirmState, setConfirmState] = useAtom(deleteGraphInputConfirmState);
  const deleteNodes = useDeleteNodesCommand();

  const close = () => setConfirmState(null);

  const confirmDelete = () => {
    if (!confirmState) {
      return;
    }

    const { nodeIds, target } = confirmState;
    close();
    deleteNodes({ nodeIds, skipGraphInputUsageConfirm: true, expectedTarget: target });
  };

  const visibleUsages = confirmState?.usages.slice(0, 8) ?? [];
  const hiddenUsageCount = (confirmState?.usages.length ?? 0) - visibleUsages.length;

  return (
    <ModalTransition>
      {confirmState && (
        <Modal autoFocus={false} onClose={close} width="small">
          <AppModalHeader title="Delete Graph Input?" onClose={close} />
          <ModalBody>
            <div css={modalBody}>
              <p>
                This input is used through Subgraph or Call Graph nodes. Deleting this input will break the connections.
              </p>
              <ul>
                {visibleUsages.map((usage) => (
                  <li key={`${usage.graphId}:${usage.callerType}:${usage.callerNodeId}:${usage.inputId}`}>
                    {usage.displayPath}
                  </li>
                ))}
              </ul>
              {hiddenUsageCount > 0 && <p>And {hiddenUsageCount} more input usages.</p>}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button appearance="subtle" onClick={close}>
              Cancel
            </Button>
            <Button appearance="danger" onClick={confirmDelete}>
              Delete Input
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
};
