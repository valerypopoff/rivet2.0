import { type FC, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useAtom } from 'jotai';
import { orderBy } from 'lodash-es';
import { overlayOpenState } from '../state/ui';
import { css } from '@emotion/react';
import clsx from 'clsx';
import { type NodeId } from '@valerypopoff/rivet2-core';
import { lastRunDataByNodeState, type NodeRunDataWithRefs } from '../state/dataFlow';
import { projectState } from '../state/savedGraphs';
import { graphState } from '../state/graph';
import { ErrorBoundary } from 'react-error-boundary';
import TextField from '@atlaskit/textfield';
import { useGoToNode } from '../hooks/useGoToNode';
import MaximizeIcon from 'majesticons/line/maximize-line.svg?react';
import MinimizeIcon from 'majesticons/line/minimize-line.svg?react';
import { useToggle } from 'ahooks';
import { RenderDataValue } from './RenderDataValue.js';
import { useDataRefs } from '../providers/ProvidersContext.js';
import {
  getChatViewerChatNodes,
  getChatViewerErrorValue,
  getChatViewerGraphEntries,
  getChatViewerNodeGraphNameMap,
  getChatViewerNodeProcesses,
  getChatViewerProcessKey,
  getChatViewerProcessRows,
  getChatViewerPromptValue,
  getChatViewerResponseValue,
} from '../utils/chatViewerData.js';

export const ChatViewerRenderer: FC = () => {
  const [openOverlay, setOpenOverlay] = useAtom(overlayOpenState);

  if (openOverlay !== 'chatViewer') return null;

  return (
    <ErrorBoundary fallback={null}>
      <ChatViewer onClose={() => setOpenOverlay(undefined)} />
    </ErrorBoundary>
  );
};

const styles = css`
  position: fixed;
  top: var(--project-selector-height);
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--grey-darker);
  z-index: 150;
  overflow: auto;

  .controls-filters {
    padding: 12px 16px;
    border-radius: 10px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 5px;
    }
    background-color: var(--grey-darkish);
    display: flex;
    align-items: center;
    box-shadow: 0 0 10px rgba(0, 0, 0, 0.2);
    margin: 56px 48px 32px 48px;
  }

  .chats {
    padding: 0 48px 56px;
    display: grid;
    gap: 28px;

    section {
      display: grid;
      gap: 16px;
      min-width: 0;
    }
  }

  .empty-state {
    color: var(--foreground-muted);
    padding: 24px;
    text-align: center;
    background: var(--grey-dark);
    border: 1px dashed var(--app-panel-border);
    border-radius: 14px;
  }

  .chat-bubble {
    background: var(--grey-dark);
    border: 1px solid var(--app-panel-border);
    border-radius: 14px;
    box-shadow: none;
    box-sizing: border-box;
    corner-shape: squircle;
    content-visibility: auto;
    contain-intrinsic-size: 150px;
    overflow: hidden;
    width: 100%;

    @supports not (corner-shape: squircle) {
      border-radius: 8px;
    }

    &.status-running {
      border-color: color-mix(in srgb, var(--primary) 58%, var(--app-panel-border));
      box-shadow: 0 0 12px color-mix(in srgb, var(--primary) 18%, transparent);
    }

    &.status-not-ran {
      border-style: dashed;
      border-color: color-mix(in srgb, var(--foreground-muted) 50%, var(--app-panel-border));
    }

    &.status-error,
    &.status-interrupted {
      border-color: var(--error);
    }

    &.status-ok,
    &.status-error {
      &:not(.expanded) .prompt {
        max-height: 0;
        padding: 0;
      }

      &:not(.expanded) .response {
        max-height: 110px;
        overflow: hidden;
      }

      &:not(.expanded) .line {
        display: none;
      }
    }

    &.status-ok header {
      border-bottom: 1px solid var(--success);
    }

    &.status-running header {
      border-bottom-color: var(--primary);
    }

    &.status-error header,
    &.status-interrupted header {
      border-bottom-color: var(--error);
    }

    &.status-not-ran header {
      border-bottom-style: dashed;
      border-bottom-color: color-mix(in srgb, var(--foreground-muted) 50%, var(--app-panel-border));
    }

    header {
      padding: 0 15px;
      background-color: var(--grey-darkish);
      border-bottom: 1px solid var(--grey-light);
      display: flex;
      align-items: center;
      gap: 16px;
      justify-content: space-between;

      .chat-title {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .graph-name,
      .node-title {
        color: var(--primary-text);
      }

      .go-to-node {
        background-color: transparent;
        color: var(--foreground);
        border: 0;
        cursor: pointer;
        display: inline-block;
        height: 32px;
        padding: 0 15px;

        &:hover {
          color: var(--primary-text);
        }
      }

      .buttons {
        display: flex;
        align-items: center;
        column-gap: 8px;
        flex-shrink: 0;

        .expand {
          border: 0;
          border-radius: 6px;
          margin: 0;
          padding: 0;
          width: 32px;
          height: 32px;
          background-color: transparent;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;

          &:hover {
            background-color: var(--grey-dark);
          }
        }
      }
    }

    .line {
      border-top: 1px solid var(--grey-light);
    }

    .prompt {
      padding: 15px;
      white-space: pre-wrap;
      max-height: 100px;
      overflow: auto;
      color: var(--foreground-muted);
    }

    .response {
      padding: 15px;
      white-space: pre-wrap;
      max-height: 480px;
      overflow: auto;
    }
  }
`;

export const ChatViewer: FC<{
  onClose: () => void;
}> = ({ onClose }) => {
  const project = useAtomValue(projectState);
  const currentGraph = useAtomValue(graphState);
  const allLastRunData = useAtomValue(lastRunDataByNodeState);
  const [graphFilter, setGraphFilter] = useState('');
  const goToNode = useGoToNode();

  const graphEntries = useMemo(
    () => getChatViewerGraphEntries(project.graphs, currentGraph),
    [currentGraph, project.graphs],
  );

  const nodesToGraphNameMap = useMemo(() => {
    return getChatViewerNodeGraphNameMap(graphEntries);
  }, [graphEntries]);

  const chatNodes = useMemo(() => {
    const nodes = getChatViewerChatNodes(graphEntries);
    if (graphFilter === '') {
      return nodes;
    }

    return nodes.filter((node) =>
      (nodesToGraphNameMap[node.id] ?? '').toLowerCase().includes(graphFilter.toLowerCase()),
    );
  }, [graphEntries, graphFilter, nodesToGraphNameMap]);

  const processes = useMemo(() => {
    return getChatViewerNodeProcesses(chatNodes, allLastRunData);
  }, [chatNodes, allLastRunData]);

  const processesWithIndex = useMemo(() => {
    return getChatViewerProcessRows(processes);
  }, [processes]);

  const orderedProcesses = useMemo(() => {
    return orderBy(processesWithIndex, ({ process }) => process.data.finishedAt ?? process.data.startedAt ?? 0, 'asc');
  }, [processesWithIndex]);

  const doGoToNode = (nodeId: NodeId) => {
    goToNode(nodeId);
    onClose();
  };

  return (
    <div css={styles}>
      <div className="controls-filters">
        <TextField
          placeholder="Graph Filter..."
          value={graphFilter}
          onChange={(e) => setGraphFilter((e.target as HTMLInputElement).value)}
        />
      </div>
      <div className="chats">
        <section className="chat-list">
          {orderedProcesses.length > 0 ? (
            orderedProcesses.map(({ node, process, index }) => {
              const graphName = nodesToGraphNameMap[node.id] ?? 'Unknown Graph';
              return (
                <ChatBubble
                  nodeId={node.id}
                  nodeTitle={node.title}
                  data={process.data}
                  key={getChatViewerProcessKey(node.id, process.processId, index)}
                  graphName={graphName}
                  onGoToNode={doGoToNode}
                  splitIndex={index}
                />
              );
            })
          ) : (
            <div className="empty-state">
              {graphFilter.trim() ? 'No chat outputs match this graph filter.' : 'No chat outputs to show yet.'}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const ChatBubble: FC<{
  graphName: string;
  nodeId: NodeId;
  nodeTitle: string;
  data: NodeRunDataWithRefs;
  splitIndex: number;
  onGoToNode?: (nodeId: NodeId) => void;
}> = ({ nodeId, nodeTitle, splitIndex, data, graphName, onGoToNode }) => {
  const dataRefs = useDataRefs();
  const promptRef = useRef<HTMLDivElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const [expanded, toggleExpanded] = useToggle();

  const prompt = useMemo(() => getChatViewerPromptValue(data, splitIndex, dataRefs), [data, dataRefs, splitIndex]);

  const chatOutput = useMemo(
    () => getChatViewerResponseValue(data, splitIndex) ?? getChatViewerErrorValue(data),
    [data, splitIndex],
  );
  const renderMode = expanded || data.status?.type !== 'ok' ? 'expanded-preview' : 'compact';

  useLayoutEffect(() => {
    if (promptRef.current) {
      if (data.status?.type === 'ok') {
        promptRef.current.scrollTop = 0;
      } else {
        promptRef.current.scrollTop = promptRef.current.scrollHeight;
      }
    }
  }, [data.status?.type, prompt]);

  useLayoutEffect(() => {
    if (responseRef.current) {
      if (data.status?.type === 'ok') {
        responseRef.current.scrollTop = 0;
      } else {
        responseRef.current.scrollTop = responseRef.current.scrollHeight;
      }
    }
  }, [chatOutput, data.status?.type]);

  if (!chatOutput) {
    return null;
  }

  return (
    <div
      className={clsx('chat-bubble', {
        expanded,
        'status-error': data.status?.type === 'error',
        'status-interrupted': data.status?.type === 'interrupted',
        'status-not-ran': data.status?.type === 'notRan',
        'status-ok': data.status?.type === 'ok',
        'status-running': data.status?.type === 'running',
      })}
    >
      <header>
        <span className="chat-title">
          <span className="node-title">{nodeTitle}</span> in <span className="graph-name">{graphName}</span>
        </span>
        <div className="buttons">
          <button type="button" className="go-to-node" onClick={() => onGoToNode?.(nodeId)}>
            Go To
          </button>
          <button
            type="button"
            aria-label={expanded ? 'Collapse chat output' : 'Expand chat output'}
            className="expand"
            onClick={toggleExpanded.toggle}
          >
            {expanded ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
        </div>
      </header>
      {prompt != null && (expanded || data.status?.type !== 'ok') ? (
        <div className="prompt" ref={promptRef}>
          <RenderDataValue value={prompt} mode={renderMode} />
        </div>
      ) : null}
      <div className="line" />
      <div className="response" ref={responseRef}>
        <RenderDataValue value={chatOutput} mode={renderMode} />
      </div>
    </div>
  );
};
