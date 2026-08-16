import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type { FC } from 'react';
import { AppModalHeader } from '../AppModalHeader.js';

const bodyStyles = css`
  display: flex;
  flex-direction: column;
  gap: 12px;

  p {
    margin: 0;
    line-height: 1.5;
  }
`;

export type EvaluationConfirmation = {
  confirmLabel: string;
  description: string;
  onConfirm: () => void;
  title: string;
};

export const EvaluationConfirmModal: FC<{
  confirmation?: EvaluationConfirmation;
  onClose: () => void;
}> = ({ confirmation, onClose }) => (
  <ModalTransition>
    {confirmation == null ? null : (
      <Modal autoFocus={false} onClose={onClose} width="small">
        <AppModalHeader title={confirmation.title} onClose={onClose} />
        <ModalBody>
          <div css={bodyStyles}>
            <p>{confirmation.description}</p>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            appearance="primary"
            onClick={() => {
              onClose();
              confirmation.onConfirm();
            }}
          >
            {confirmation.confirmLabel}
          </Button>
        </ModalFooter>
      </Modal>
    )}
  </ModalTransition>
);
