import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import { atom, useAtom, useAtomValue } from 'jotai';
import { useEffect, useRef, useState, type FC } from 'react';
import {
  isGraphBuilderTerminalViewState,
  type GraphBuilderSessionViewState,
} from '../features/graphBuilder/sessionController.js';
import {
  isGraphBuilderSessionWorking,
  selectGraphBuilderSessionState,
} from '../features/graphBuilder/sessionPresentation.js';
import { useLegacyAiGraphBuilder } from '../hooks/useAiGraphBuilder.js';
import { useCenterViewOnGraph } from '../hooks/useCenterViewOnGraph.js';
import { usePlanBGraphBuilder } from '../hooks/usePlanBGraphBuilder.js';
import { aiAssistCustomModelState, aiAssistCustomProviderBaseURLState, selectedAssistModelState } from '../state/ai.js';
import { graphState } from '../state/graph.js';
import { graphBuilderImplementationModeState, type GraphBuilderImplementationMode } from '../state/graphBuilderAi.js';
import { resolveAiAssistModelSettings } from '../utils/aiAssistModelSettings.js';
import { wrapAsync } from '../utils/errorHandling.js';
import { AiAssistPromptModal } from './AiAssistPromptModal.js';
import { GraphBuilderSessionPanel } from './GraphBuilderSessionPanel.js';

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
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [show, setShow] = useAtom(showAiGraphCreatorInputState);
  const implementationMode = useAtomValue(graphBuilderImplementationModeState);
  const latchedModeRef = useRef<GraphBuilderImplementationMode>();
  const feedbackLogRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedAssistModel = useAtomValue(selectedAssistModelState);
  const customAssistProviderBaseURL = useAtomValue(aiAssistCustomProviderBaseURLState);
  const customAssistModel = useAtomValue(aiAssistCustomModelState);
  const activeGraph = useAtomValue(graphState);
  const centerViewOnGraph = useCenterViewOnGraph();

  const assistModel = resolveAiAssistModelSettings({
    customModel: customAssistModel,
    customProviderBaseURL: customAssistProviderBaseURL,
    selectedModel: selectedAssistModel,
  });
  const planB = usePlanBGraphBuilder();
  const planBState = planB.state;

  const legacy = useLegacyAiGraphBuilder({
    onFeedback: (feedback: string) => {
      setFeedbackItems((previous) => [...previous, feedback]);
    },
  });
  const legacyState = legacy.state;

  const resetPlanB = planB.reset;
  const resetLegacy = legacy.reset;
  useEffect(() => {
    if (show) {
      return;
    }
    void resetLegacy();
    void resetPlanB();
    latchedModeRef.current = undefined;
    setClarificationAnswer('');
    setFeedbackItems([]);
  }, [resetLegacy, resetPlanB, show]);

  useEffect(() => {
    const log = feedbackLogRef.current;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }, [feedbackItems]);

  const runLegacyPrompt = async () => {
    setFeedbackItems([]);
    await legacy.start(prompt, assistModel);
  };

  const runPrimaryAction = wrapAsync(async () => {
    const mode = latchedModeRef.current;
    if (!mode) {
      if (!prompt.trim() || assistModel.missingConfiguration) {
        return;
      }
      latchedModeRef.current = implementationMode;
      if (implementationMode === 'legacy') {
        await runLegacyPrompt();
      } else {
        await planB.start(prompt);
      }
      return;
    }

    if (mode === 'legacy') {
      if (!legacyState) {
        await legacy.start(prompt, assistModel);
      } else if (legacyState.status === 'ready-for-preview') {
        await legacy.apply();
      } else if (isGraphBuilderTerminalViewState(legacyState)) {
        await legacy.reset();
        latchedModeRef.current = undefined;
        setShow(false);
      }
      return;
    }
    if (!planBState) {
      await planB.start(prompt);
      return;
    }
    if (planBState.status === 'awaiting-user') {
      await planB.resume(clarificationAnswer);
      setClarificationAnswer('');
      return;
    }
    if (planBState.status === 'ready-for-preview') {
      await planB.apply();
      return;
    }
    if (isGraphBuilderTerminalViewState(planBState)) {
      await planB.reset();
      latchedModeRef.current = undefined;
      setShow(false);
    }
  }, 'Run Graph Builder action');

  const cancelGeneration = wrapAsync(async () => {
    if (latchedModeRef.current === 'plan-b') {
      await planB.cancel();
    } else {
      await legacy.cancel();
    }
  }, 'Cancel Graph Builder');

  const closeModal = wrapAsync(async () => {
    const activeState = selectGraphBuilderSessionState(latchedModeRef.current, {
      legacy: legacyState,
      planB: planBState,
    });
    if (activeState?.status === 'committing') {
      return;
    }
    if (activeState && !isGraphBuilderTerminalViewState(activeState)) {
      const shouldDiscard = window.confirm('Discard the private Graph Builder draft and close?');
      if (!shouldDiscard) {
        return;
      }
      if (latchedModeRef.current === 'legacy') {
        await legacy.discard();
      } else {
        await planB.discard();
      }
    }
    await legacy.reset();
    await planB.reset();
    latchedModeRef.current = undefined;
    setShow(false);
  }, 'Close Graph Builder');

  const viewGraph = () => {
    centerViewOnGraph(activeGraph);
    closeModal();
  };

  const discardDraft = wrapAsync(async () => {
    if (latchedModeRef.current === 'legacy') {
      await legacy.discard();
    } else {
      await planB.discard();
    }
  }, 'Discard Graph Builder draft');

  const startOver = wrapAsync(async () => {
    const activeState = selectGraphBuilderSessionState(latchedModeRef.current, {
      legacy: legacyState,
      planB: planBState,
    });
    if (activeState?.status === 'ready-for-preview' && !window.confirm('Discard this private draft and start over?')) {
      return;
    }
    await legacy.reset();
    await planB.reset();
    latchedModeRef.current = undefined;
    setClarificationAnswer('');
  }, 'Start Graph Builder over');

  if (!show) {
    return null;
  }

  const mode = latchedModeRef.current;
  const isPlanBSession = mode === 'plan-b';
  const activeState = selectGraphBuilderSessionState(mode, {
    legacy: legacyState,
    planB: planBState,
  });
  const isWorking = isGraphBuilderSessionWorking(activeState);
  const promptIsLocked = activeState != null;
  const primary = getPrimaryAction(activeState, {
    idle: mode == null,
    legacyRunning: mode === 'legacy' && isWorking,
    missingConfiguration: Boolean(assistModel.missingConfiguration),
    prompt,
    clarificationAnswer,
  });

  return (
    <AiAssistPromptModal
      bodyExtra={
        activeState ? (
          <>
            <GraphBuilderSessionPanel
              clarificationAnswer={clarificationAnswer}
              onClarificationAnswerChange={setClarificationAnswer}
              state={activeState}
            />
            {!isPlanBSession && feedbackItems.length > 0 ? (
              <textarea
                aria-label="AI graph generation log"
                css={feedbackStyles}
                readOnly
                ref={feedbackLogRef}
                value={feedbackItems.join('\n')}
              />
            ) : null}
          </>
        ) : feedbackItems.length > 0 ? (
          <textarea
            aria-label="AI graph generation log"
            css={feedbackStyles}
            readOnly
            ref={feedbackLogRef}
            value={feedbackItems.join('\n')}
          />
        ) : null
      }
      footerExtra={
        activeState ? (
          <GraphBuilderFooterActions
            onDiscard={discardDraft}
            onStartOver={startOver}
            onViewGraph={viewGraph}
            state={activeState}
          />
        ) : null
      }
      generateDisabled={primary.disabled}
      generateLabel={primary.label}
      isDisabled={promptIsLocked}
      isOpen={show}
      missingConfiguration={mode == null ? assistModel.missingConfiguration : undefined}
      modelDisplayName={
        mode === 'plan-b'
          ? planB.capturedModelDisplayName ?? assistModel.displayName
          : mode === 'legacy'
            ? legacy.capturedModelDisplayName ?? assistModel.displayName
            : assistModel.displayName
      }
      onCancel={isWorking ? cancelGeneration : undefined}
      onClose={closeModal}
      onGenerate={runPrimaryAction}
      onPromptChange={setPrompt}
      placeholder="Describe the graph to create or edit..."
      prompt={prompt}
      title="Generate graph using AI"
      working={isWorking}
    />
  );
};

function getPrimaryAction(
  state: GraphBuilderSessionViewState | undefined,
  context: {
    idle: boolean;
    legacyRunning: boolean;
    missingConfiguration: boolean;
    prompt: string;
    clarificationAnswer: string;
  },
): { disabled: boolean; label: string } {
  if (context.legacyRunning) {
    return { disabled: true, label: 'Generating…' };
  }
  if (context.idle || !state) {
    return {
      disabled: context.missingConfiguration || !context.prompt.trim(),
      label: 'Generate',
    };
  }
  if (state.status === 'gathering-context' || state.status === 'editing' || state.status === 'repairing') {
    return { disabled: true, label: 'Preparing draft…' };
  }
  if (state.status === 'awaiting-user') {
    return {
      disabled: !context.clarificationAnswer.trim(),
      label: 'Resume',
    };
  }
  if (state.status === 'ready-for-preview') {
    return { disabled: false, label: 'Apply' };
  }
  if (state.status === 'committing') {
    return { disabled: true, label: 'Applying…' };
  }
  return { disabled: false, label: 'Close' };
}

function GraphBuilderFooterActions({
  onDiscard,
  onStartOver,
  onViewGraph,
  state,
}: {
  onDiscard: () => void;
  onStartOver: () => void;
  onViewGraph: () => void;
  state: GraphBuilderSessionViewState;
}) {
  if (state.status === 'awaiting-user') {
    return <Button onClick={onDiscard}>Discard</Button>;
  }
  if (state.status === 'ready-for-preview') {
    return (
      <>
        <Button onClick={onDiscard}>Discard</Button>
        <Button onClick={onStartOver}>Start over</Button>
      </>
    );
  }
  if (state.status === 'committed') {
    return <Button onClick={onViewGraph}>View graph</Button>;
  }
  if (isGraphBuilderTerminalViewState(state)) {
    return <Button onClick={onStartOver}>Start over</Button>;
  }
  return null;
}
