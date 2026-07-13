import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type { FC } from 'react';
import { AppModalHeader } from './AppModalHeader.js';

const confirmBody = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

export const DeleteResourceConfirmModal: FC<{
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
