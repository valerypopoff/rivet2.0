import { type ChangeEvent, type FC, useLayoutEffect, useRef, useState } from 'react';
import Button from '@atlaskit/button';
import TextArea from '@atlaskit/textarea';
import { type ChatMessage, type GraphId, type NodeTestGroup, type PortId, coerceType } from '@valerypopoff/rivet2-core';
import { findIndex } from 'lodash-es';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { useMultilineEditorFontSize } from '../../hooks/useMultilineEditorFontSize.js';
import { GraphSelector } from '../editors/GraphSelectorEditor';
import type { PromptDesignerTestGroupResults } from '../../state/promptDesigner';

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

export const PromptDesignerTestGroup: FC<{
  testGroup: NodeTestGroup;
  onChange: (testGroup: NodeTestGroup) => void;
  onStart: (testGroup: NodeTestGroup) => void;
  onDelete: (testGroup: NodeTestGroup) => void;
  inProgress: boolean;
  onCancel?: () => void;
}> = ({ testGroup, onChange, onStart, onDelete, inProgress, onCancel }) => {
  const {
    fontSize,
    handleKeyDown: handleMultilineEditorFontSizeKeyDown,
    handleWheel: handleMultilineEditorFontSizeWheel,
  } = useMultilineEditorFontSize();
  const hasEvaluatorGraph = Boolean(testGroup.evaluatorGraphId);

  return (
    <div className="test-group">
      <Button appearance="subtle" className="delete-test-group-button" onClick={() => onDelete(testGroup)}>
        &times;
      </Button>
      <GraphSelector
        label="Evaluator Graph"
        value={testGroup.evaluatorGraphId || undefined}
        onChange={(selected) => onChange({ ...testGroup, evaluatorGraphId: selected as GraphId })}
        isReadonly={false}
        name={`evaluator-graph-${testGroup.id}`}
        helperMessage="Required. The evaluator graph receives the generated response on input and the condition texts on conditions, then returns output as boolean[]."
      />
      <div className="test-group-tests">
        {testGroup.tests.map((test, index) => (
          <div className="test-group-test" key={`test-${index}`}>
            <div className="test-group-test-controls">
              <TextArea
                placeholder="Enter test condition"
                value={test.conditionText}
                onKeyDown={(event) => {
                  if (handleMultilineEditorFontSizeKeyDown(event.nativeEvent)) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onWheel={(event) => handleMultilineEditorFontSizeWheel(event.nativeEvent)}
                onChange={(event) =>
                  onChange({
                    ...testGroup,
                    tests: testGroup.tests.map((currentTest, currentIndex) =>
                      currentIndex === index
                        ? { ...currentTest, conditionText: (event.target as HTMLTextAreaElement).value }
                        : currentTest,
                    ),
                  })
                }
                style={{ fontSize }}
              />
              <Button
                appearance="subtle"
                className="delete-test-button"
                onClick={() =>
                  onChange({
                    ...testGroup,
                    tests: testGroup.tests.filter((_, currentIndex) => currentIndex !== index),
                  })
                }
              >
                &times;
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="test-group-buttons">
        <Button
          appearance="subtle-link"
          onClick={() =>
            onChange({
              ...testGroup,
              tests: [
                ...testGroup.tests,
                {
                  conditionText: '',
                },
              ],
            })
          }
        >
          Add Test
        </Button>
        {inProgress ? (
          <Button appearance="danger" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button appearance="primary" onClick={() => onStart(testGroup)} isDisabled={!hasEvaluatorGraph}>
            Start
          </Button>
        )}
      </div>
    </div>
  );
};

export const PromptDesignerTestGroupResultList: FC<{
  results: PromptDesignerTestGroupResults[];
}> = ({ results }) => {
  return (
    <div className="test-group-results">
      {results.map((result, index) => (
        <PromptDesignerTestGroupResult key={`result-${index}`} result={result} index={index} />
      ))}
    </div>
  );
};

export const PromptDesignerTestGroupResult: FC<{
  result: PromptDesignerTestGroupResults;
  index: number;
}> = ({ result, index }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="test-group-result">
      <header>Sample {index + 1}</header>
      <Button appearance="subtle" className="test-group-result-expand" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide' : 'Show'} Response
      </Button>
      {expanded && <pre className="pre-wrap test-group-result-response">{result.response}</pre>}
      <div className="test-group-result-conditions">
        {result.results.map((conditionResult, conditionIndex) => (
          <div key={`result-${conditionIndex}`} className="test-group-result-condition-result">
            {conditionResult.pass ? <span className="pass">Pass</span> : <span className="fail">Fail</span>}
            <span className="condition">{conditionResult.conditionText}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
