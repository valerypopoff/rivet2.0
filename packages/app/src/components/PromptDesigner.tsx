import { css } from '@emotion/react';
import { type FC } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { nanoid } from 'nanoid/non-secure';
import { AppErrorBoundary } from './AppErrorBoundary';
import Button from '@atlaskit/button';
import { overlayOpenState } from '../state/ui';
import { graphState } from '../state/graph.js';
import { projectState } from '../state/savedGraphs.js';
import { evaluationsState } from '../state/evaluations.js';
import { wrapAsync } from '../utils/errorHandling';
import { toast } from 'react-toastify';
import { usePromptDesignerMessages } from '../hooks/usePromptDesignerMessages';
import { PromptDesignerConfigPanel } from './promptDesigner/PromptDesignerConfigPanel';
import { PromptDesignerMessageList } from './promptDesigner/PromptDesignerMessageList.js';
import { PromptDesignerResponsePane } from './promptDesigner/PromptDesignerResponsePane.js';
import { usePromptDesignerAttachedNode } from './promptDesigner/usePromptDesignerAttachedNode.js';
import { usePromptDesignerRunActions } from './promptDesigner/usePromptDesignerRunActions.js';

const styles = css`
  position: fixed;
  top: var(--project-selector-height);
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--grey-darker);
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.2);
  z-index: 150;

  .close-prompt-designer {
    position: absolute;
    top: 0;
    right: 0;
    z-index: 10;
    cursor: pointer;
  }

  .prompt-designer-content {
    display: grid;
    grid-template-columns: 2fr 2fr 1fr;
    height: 100%;
  }

  .message-area {
    border-right: 1px solid var(--grey);
    padding: 20px;
    height: 100%;
    min-height: 0;
    overflow: auto;
    padding-top: 32px;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .message {
    border-bottom: 1px solid var(--grey);
    padding: 10px 5px;
    cursor: pointer;
    font-size: var(--ui-font-size-base);
    line-height: 22px;
    font-family: var(--font-family);
    display: flex;
    flex-direction: column;
    position: relative;
    gap: 8px;

    .message-author-type {
      width: 100px;
    }

    .message-text {
      width: 100%;
    }

    .message-delete-button-container {
      width: 40px;
      position: absolute;
      top: 10px;
      right: 5px;
    }

    .message-text pre {
      font-family: var(--font-family);
      user-select: none;
    }
  }

  .response-area {
    border-right: 1px solid var(--grey);
    padding: 20px;
    height: 100%;
    overflow: auto;
    padding-top: 32px;
  }

  .controls-area {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .panel {
    width: 100%;
    height: 100%;
  }

  .controls-buttons {
    padding: 20px;
    display: flex;
    justify-content: flex-end;
  }

  .message-editor {
    width: 100%;
    font-size: var(--ui-font-size-base);
    font-family: var(--font-family);
    line-height: 22px;
    resize: none;
    overflow: hidden;
    border: solid 1px transparent;
    background: transparent;
    outline: none;
    padding: 10px;
    &:focus {
      border: solid 1px var(--grey-lightest);
    }

    &:hover {
      background-color: rgba(0, 0, 0, 0.1);
    }
  }

  .chat-config-area {
    display: grid;
    height: 100%;
    grid-template-rows: 1fr auto;
  }

  .chat-config-controls {
    padding: 20px;
    border-bottom: 1px solid var(--grey);
  }

  .add-message {
    justify-self: stretch;
    display: flex;
    justify-content: center;
    font-size: var(--ui-font-size-sm);

    &:hover {
      background-color: rgba(0, 0, 0, 0.1);
    }
  }
`;

export const PromptDesignerRenderer: FC = () => {
  const [openOverlay, setOpenOverlay] = useAtom(overlayOpenState);

  if (openOverlay !== 'promptDesigner') {
    return null;
  }

  return (
    <AppErrorBoundary context="Prompt Designer" fallback={<div>Failed to render Prompt Designer</div>}>
      <PromptDesigner onClose={() => setOpenOverlay(undefined)} />
    </AppErrorBoundary>
  );
};

export type PromptDesignerProps = {
  onClose: () => void;
};

export const PromptDesigner: FC<PromptDesignerProps> = ({ onClose }) => {
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const graph = useAtomValue(graphState);
  const project = useAtomValue(projectState);
  const setEvaluations = useSetAtom(evaluationsState);
  const { messages, setMessages, messageChanged, deleteMessage, addMessage } = usePromptDesignerMessages();
  const { attachedNode, config, setConfig } = usePromptDesignerAttachedNode({ setMessages });
  const { response, tryRunSingle } = usePromptDesignerRunActions({
    configData: config.data,
    messages,
  });

  const openInEvaluations = () => {
    const graphId = graph.metadata?.id;
    if (!attachedNode || !graphId) {
      // The designer can open with an old/deleted selection. Do not create an
      // ambiguous suite in that case.
      toast.error('Select an LLM Chat node in a saved graph before opening an evaluation.');
      return;
    }
    const candidateGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === attachedNode.id ? { ...node, data: { ...config.data } } : node)),
    };
    const candidateProject = {
      ...project,
      graphs: { ...project.graphs, [graphId]: candidateGraph },
    };
    setEvaluations((current) => {
      const existing = current.data.suites.find((suite) => suite.targetGraphId === graphId);
      const projectDatasets = current.datasets;
      if (existing) {
        return {
          ...current,
          selectedSuiteId: existing.id,
          selectedDatasetId: undefined,
          // This candidate lives only in the function passed below. Persisting
          // definitions never writes the unsaved prompt settings into the file.
          promptDesignerProjectOverride: { project: candidateProject, projectId: project.metadata.id, graphId },
        };
      }
      const nextDataset = projectDatasets[0] ?? {
        id: nanoid(),
        name: 'Prompt Designer evaluation cases',
        fields: [],
        cases: [],
      };
      const suite = {
        id: nanoid(),
        name: `Evaluate ${graph.metadata?.name ?? graphId}`,
        targetGraphId: graphId,
        datasetId: nextDataset.id,
        inputBindings: [],
        assertions: [],
        evaluators: [],
        configuration: { trialCount: 1, concurrency: 4, recordingRetention: 'failures-and-baselines' as const },
        thresholds: [],
      };
      return {
        ...current,
        datasets: projectDatasets.length === 0 ? [...current.datasets, nextDataset] : current.datasets,
        data: {
          ...current.data,
          suites: [...current.data.suites, suite],
        },
        selectedSuiteId: suite.id,
        selectedDatasetId: undefined,
        // This candidate lives only in the function passed below. Persisting
        // definitions never writes the unsaved prompt settings into the file.
        promptDesignerProjectOverride: { project: candidateProject, projectId: project.metadata.id, graphId },
      };
    });
    setOpenOverlay('evaluations');
  };

  return (
    <div css={styles}>
      <Button className="close-prompt-designer" appearance="subtle" onClick={onClose}>
        &times;
      </Button>

      <div className="prompt-designer-content">
        <div className="message-area">
          <PromptDesignerMessageList
            messages={messages}
            addMessage={addMessage}
            deleteMessage={deleteMessage}
            messageChanged={messageChanged}
          />
        </div>
        <div className="response-area">
          <PromptDesignerResponsePane response={response.response} />
        </div>
        <div className="controls-area">
          <PromptDesignerConfigPanel
            config={config}
            setConfig={setConfig}
            onRun={wrapAsync(tryRunSingle, 'Run prompt designer chat')}
          />
          <div className="controls-buttons">
            <Button appearance="subtle" onClick={openInEvaluations}>
              Open in Evaluations
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
