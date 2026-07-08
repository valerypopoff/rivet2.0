import { css } from '@emotion/react';
import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { useAiGraphBuilder } from '../hooks/useAiGraphBuilder';
import {
  aiAssistCustomModelState,
  aiAssistCustomProviderBaseURLState,
  selectedAssistModelState,
} from '../state/ai';
import { resolveAiAssistModelSettings } from '../utils/aiAssistModelSettings.js';
import { wrapAsync } from '../utils/errorHandling';
import { AiAssistPromptModal } from './AiAssistPromptModal.js';

const AI_GRAPH_CREATOR_CANCEL_REASON = 'AI graph creator canceled';

const feedbackStyles = css`
  min-height: calc(120px * var(--ui-font-scale));
  max-height: calc(240px * var(--ui-font-scale));
  width: 100%;
  box-sizing: border-box;
  overflow: auto;
  resize: vertical;
  border: 1px solid var(--grey);
  border-radius: var(--ui-button-radius);
  background: var(--grey-dark);
  color: var(--grey-light);
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-sm);
  line-height: 1.35;
  padding: calc(8px * var(--ui-font-scale));
  white-space: pre-wrap;
`;

export const showAiGraphCreatorInputState = atom(false);

export const AiGraphCreatorInput: FC = () => {
  const [feedbackItems, setFeedbackItems] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [show, setShow] = useAtom(showAiGraphCreatorInputState);
  const abortControllerRef = useRef<AbortController | null>(null);
  const feedbackLogRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedAssistModel = useAtomValue(selectedAssistModelState);
  const customAssistProviderBaseURL = useAtomValue(aiAssistCustomProviderBaseURLState);
  const customAssistModel = useAtomValue(aiAssistCustomModelState);

  const assistModel = resolveAiAssistModelSettings({
    customModel: customAssistModel,
    customProviderBaseURL: customAssistProviderBaseURL,
    selectedModel: selectedAssistModel,
  });

  const buildFromPrompt = useAiGraphBuilder({
    onFeedback: (feedback) => {
      setFeedbackItems((prev) => [...prev, feedback]);
    },
  });

  const abortGeneration = useCallback(() => {
    abortControllerRef.current?.abort(AI_GRAPH_CREATOR_CANCEL_REASON);
  }, []);

  const closeModal = useCallback(() => {
    abortGeneration();
    setShow(false);
  }, [abortGeneration, setShow]);

  useEffect(() => {
    if (show) {
      return undefined;
    }

    abortGeneration();
    setFeedbackItems([]);
    return undefined;
  }, [abortGeneration, show]);

  useEffect(
    () => () => {
      abortGeneration();
    },
    [abortGeneration],
  );

  useEffect(() => {
    const log = feedbackLogRef.current;
    if (!log) {
      return;
    }

    log.scrollTop = log.scrollHeight;
  }, [feedbackItems]);

  const runPrompt = wrapAsync(async () => {
    if (running || assistModel.missingConfiguration || !prompt.trim()) {
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setRunning(true);
    setFeedbackItems([]);

    try {
      const didApply = await buildFromPrompt(prompt, assistModel, abortController.signal);

      if (!abortController.signal.aborted && didApply) {
        setPrompt('');
        setFeedbackItems([]);
        setShow(false);
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null;
        setRunning(false);
      }
    }
  }, 'Apply AI graph prompt');

  if (!show) {
    return null;
  }

  return (
    <AiAssistPromptModal
      bodyExtra={
        feedbackItems.length > 0 ? (
          <textarea
            aria-label="AI graph generation log"
            css={feedbackStyles}
            readOnly
            ref={feedbackLogRef}
            value={feedbackItems.join('\n')}
          />
        ) : null
      }
      generateDisabled={running || Boolean(assistModel.missingConfiguration) || !prompt.trim()}
      isOpen={show}
      missingConfiguration={assistModel.missingConfiguration}
      modelDisplayName={assistModel.displayName}
      onCancel={closeModal}
      onClose={closeModal}
      onGenerate={runPrompt}
      onPromptChange={setPrompt}
      placeholder="Describe the graph to create or edit..."
      prompt={prompt}
      title="Generate graph using AI"
      working={running}
    />
  );
};
