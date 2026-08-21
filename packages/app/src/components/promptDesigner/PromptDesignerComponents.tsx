import { type ChangeEvent, type FC, useLayoutEffect, useRef } from 'react';
import Button from '@atlaskit/button';
import { type ChatMessage, type PortId, coerceType } from '@valerypopoff/rivet2-core';
import { findIndex } from 'lodash-es';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { useMultilineEditorFontSize } from '../../hooks/useMultilineEditorFontSize.js';

const CHAT_MESSAGE_TYPES = ['user', 'assistant', 'system', 'developer', 'function'] as const;

export const PromptDesignerMessage: FC<{
  message: ChatMessage;
  onChange: (message: ChatMessage) => void;
  onDelete: () => void;
}> = ({ message, onChange, onDelete }) => {
  const {
    fontSize,
    handleKeyDown: handleMultilineEditorFontSizeKeyDown,
    handleWheel: handleMultilineEditorFontSizeWheel,
  } = useMultilineEditorFontSize();

  const toggleAuthorType = useStableCallback(() => {
    const index = findIndex(CHAT_MESSAGE_TYPES, (type) => message.type === type);
    const nextMessageType = CHAT_MESSAGE_TYPES[(index + 1) % CHAT_MESSAGE_TYPES.length]!;
    onChange({
      ...message,
      type: nextMessageType,
    } as ChatMessage);
  });

  const onTextChange = useStableCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange({
      ...message,
      message: event.target.value,
    });
  });

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea != null && textarea.scrollHeight > 0) {
      textarea.style.marginBottom = textarea.style.height ?? '10px';
      textarea.style.height = 'inherit';
      textarea.style.height = `${textarea.scrollHeight + 10}px`;
      textarea.style.marginBottom = 'unset';
    }
  }, [fontSize, message.message]);

  const stringMessage = coerceType({ type: 'chat-message', value: message }, 'string');

  return (
    <div className="message">
      <div className="message-author-type">
        <Button className="toggle-author-type" onClick={toggleAuthorType}>
          {message.type}
        </Button>
      </div>
      <div className="message-text">
        <textarea
          autoFocus
          className="message-editor"
          value={stringMessage}
          onClick={(event) => event.stopPropagation()}
          onChange={onTextChange}
          onKeyDown={(event) => {
            if (handleMultilineEditorFontSizeKeyDown(event.nativeEvent)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onWheel={(event) => handleMultilineEditorFontSizeWheel(event.nativeEvent)}
          ref={textareaRef}
          style={{ fontSize }}
        />
      </div>
      <div className="message-delete-button-container">
        <Button appearance="subtle" className="message-delete-button" onClick={onDelete}>
          &times;
        </Button>
      </div>
    </div>
  );
};
