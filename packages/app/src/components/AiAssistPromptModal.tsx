import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import TextArea from '@atlaskit/textarea';
import { css } from '@emotion/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useMultilineEditorFontSize } from '../hooks/useMultilineEditorFontSize.js';
import { AppModalHeader } from './AppModalHeader.js';

const styles = css`
  .ai-assist-modal-panel {
    display: flex;
    flex-direction: column;
    gap: calc(16px * var(--ui-font-scale));
  }

  .ai-assist-textarea-shell {
    width: 100%;
  }

  .ai-assist-textarea-shell .text-area,
  .ai-assist-textarea-shell textarea {
    width: 100%;
  }

  .ai-assist-textarea-shell textarea {
    border-radius: var(--ui-button-radius);
    corner-shape: squircle;
  }

  .ai-assist-model-note {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    line-height: 1.35;

    strong {
      color: var(--foreground);
      font-weight: 600;
    }
  }

  .ai-assist-textarea-shell + .ai-assist-model-note {
    margin-top: calc(4px * var(--ui-font-scale));
  }

  .ai-assist-missing-configuration {
    color: var(--warning);
  }
`;

export type AiAssistPromptModalProps = {
  isOpen: boolean;
  title: string;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelDisplayName: string;
  onClose: () => void;
  onGenerate: () => void | Promise<void>;
  bodyExtra?: ReactNode;
  footerExtra?: ReactNode;
  generateDisabled?: boolean;
  generateLabel?: string;
  isDisabled?: boolean;
  isReadonly?: boolean;
  missingConfiguration?: string;
  onCancel?: () => void;
  placeholder?: string;
  minimumRows?: number;
  working?: boolean;
};

export function AiAssistPromptModal({
  bodyExtra,
  footerExtra,
  generateDisabled = false,
  generateLabel = 'Generate',
  isDisabled = false,
  isOpen,
  isReadonly = false,
  minimumRows = 4,
  missingConfiguration,
  modelDisplayName,
  onCancel,
  onClose,
  onGenerate,
  onPromptChange,
  placeholder = 'What should Rivet generate?',
  prompt,
  title,
  working = false,
}: AiAssistPromptModalProps) {
  const {
    fontSize,
    handleKeyDown: handleMultilineEditorFontSizeKeyDown,
    handleWheel: handleMultilineEditorFontSizeWheel,
  } = useMultilineEditorFontSize();

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (handleMultilineEditorFontSizeKeyDown(e.nativeEvent)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (!generateDisabled && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void onGenerate();
    }
  };

  return (
    <ModalTransition>
      {isOpen && (
        <Modal autoFocus={false} onClose={onClose} width="large">
          <AppModalHeader title={title} onClose={onClose} />
          <ModalBody>
            <div css={styles} className="ai-assist-modal-panel">
              <div className="ai-assist-textarea-shell">
                <TextArea
                  className="text-area"
                  isDisabled={isDisabled || working}
                  isReadOnly={isReadonly}
                  minimumRows={minimumRows}
                  onChange={(e) => onPromptChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onWheel={(e) => handleMultilineEditorFontSizeWheel(e.nativeEvent)}
                  placeholder={placeholder}
                  resize="vertical"
                  style={{ fontSize }}
                  value={prompt}
                />
              </div>
              <div className="ai-assist-model-note">
                <span>
                  Using <strong>{modelDisplayName}</strong>. To change it, go to Settings &gt; LLM.
                </span>
                {missingConfiguration && <div className="ai-assist-missing-configuration">{missingConfiguration}</div>}
              </div>
              {bodyExtra}
            </div>
          </ModalBody>
          <ModalFooter>
            {footerExtra}
            {working && onCancel ? (
              <Button aria-label="Cancel generation" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button appearance="primary" onClick={() => void onGenerate()} isDisabled={generateDisabled}>
              {generateLabel}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </ModalTransition>
  );
}
