import TextArea from '@atlaskit/textarea';
import { css } from '@emotion/react';
import React, { type ReactNode } from 'react';
import {
  isGraphBuilderTerminalViewState,
  type GraphBuilderPreview,
  type GraphBuilderSessionViewState,
} from '../features/graphBuilder/sessionController.js';
import { graphBuilderStringTupleKey, type GraphDraftDelta } from '../domain/graphBuilder/index.js';

const styles = css`
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--ui-font-scale));

  .graph-builder-session-card {
    border: 1px solid var(--grey);
    border-radius: var(--ui-button-radius);
    background: var(--grey-dark);
    padding: calc(12px * var(--ui-font-scale));
  }

  .graph-builder-session-heading {
    color: var(--foreground);
    font-weight: 600;
    margin-bottom: calc(6px * var(--ui-font-scale));
  }

  .graph-builder-session-copy {
    color: var(--grey-light);
    line-height: 1.4;
    white-space: pre-wrap;
  }

  .graph-builder-session-delta,
  .graph-builder-session-change-list,
  .graph-builder-session-diagnostics {
    margin: calc(8px * var(--ui-font-scale)) 0 0;
    padding-left: calc(20px * var(--ui-font-scale));
    color: var(--grey-light);
  }

  .graph-builder-session-change-groups {
    display: grid;
    gap: calc(8px * var(--ui-font-scale));
    margin-top: calc(10px * var(--ui-font-scale));
  }

  .graph-builder-session-change-heading {
    color: var(--foreground);
    font-weight: 600;
  }

  .graph-builder-session-change-list {
    margin-top: calc(4px * var(--ui-font-scale));
    overflow-wrap: anywhere;
  }

  .graph-builder-session-change-kind,
  .graph-builder-session-change-fields {
    color: var(--grey-light);
  }

  .graph-builder-session-diagnostic-error {
    color: var(--danger);
  }

  .graph-builder-session-diagnostic-warning {
    color: var(--warning);
  }
`;

export function GraphBuilderSessionPanel({
  clarificationAnswer,
  onClarificationAnswerChange,
  state,
}: {
  clarificationAnswer: string;
  onClarificationAnswerChange: (answer: string) => void;
  state: GraphBuilderSessionViewState;
}) {
  if (state.status === 'created') {
    return null;
  }

  if (state.status === 'gathering-context' || state.status === 'editing' || state.status === 'repairing') {
    return (
      <div css={styles}>
        <section className="graph-builder-session-card" aria-live="polite">
          <div className="graph-builder-session-heading">Preparing a private draft</div>
          <div className="graph-builder-session-copy">{state.progress}</div>
        </section>
      </div>
    );
  }

  if (state.status === 'awaiting-user') {
    return (
      <div css={styles}>
        <section className="graph-builder-session-card">
          <div className="graph-builder-session-heading">Graph Builder needs clarification</div>
          <div className="graph-builder-session-copy">{state.question}</div>
        </section>
        <TextArea
          aria-label="Graph Builder clarification answer"
          minimumRows={3}
          onChange={(event) => onClarificationAnswerChange(event.target.value)}
          placeholder="Your answer…"
          value={clarificationAnswer}
        />
      </div>
    );
  }

  if (state.status === 'ready-for-preview' || state.status === 'committing') {
    const { preview } = state;
    return (
      <div css={styles}>
        <section className="graph-builder-session-card">
          <div className="graph-builder-session-heading">
            {state.status === 'committing' ? 'Applying the draft…' : 'Ready to preview and apply'}
          </div>
          <GraphBuilderPreviewContent preview={preview} />
        </section>
      </div>
    );
  }

  if (!isGraphBuilderTerminalViewState(state)) {
    return null;
  }

  const result = state.result;
  const diagnostics = result.status === 'failed' || result.status === 'budget-exhausted' ? result.diagnostics : [];
  return (
    <div css={styles}>
      <section className="graph-builder-session-card" aria-live="polite">
        <div className="graph-builder-session-heading">{terminalHeading(result.status)}</div>
        <div className="graph-builder-session-copy">{terminalMessage(result)}</div>
        {diagnostics.length > 0 ? (
          <ul className="graph-builder-session-diagnostics">
            {diagnostics.map((diagnostic) => (
              <li className={`graph-builder-session-diagnostic-${diagnostic.severity}`} key={diagnostic.diagnosticKey}>
                {diagnostic.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {state.retainedPreview ? (
        <section className="graph-builder-session-card">
          <div className="graph-builder-session-heading">Retained private-draft preview</div>
          <GraphBuilderPreviewContent preview={state.retainedPreview} />
        </section>
      ) : null}
    </div>
  );
}

function GraphBuilderPreviewContent({ preview }: { preview: GraphBuilderPreview }) {
  const delta = preview.delta;
  return (
    <>
      <div className="graph-builder-session-copy">{preview.summary}</div>
      <ul className="graph-builder-session-delta">
        <li>{delta.addedNodeCount ?? delta.addedNodes.length} nodes added</li>
        <li>{delta.updatedNodeCount ?? delta.updatedNodes.length} nodes updated</li>
        <li>{delta.removedNodeCount ?? delta.removedNodes.length} nodes removed</li>
        <li>{delta.addedConnectionCount ?? delta.addedConnections.length} connections added</li>
        <li>{delta.removedConnectionCount ?? delta.removedConnections.length} connections removed</li>
        {delta.truncated ? <li>Detailed change lists are truncated.</li> : null}
      </ul>
      <GraphBuilderDeltaDetails delta={delta} />
      {preview.diagnostics.length > 0 ? (
        <ul className="graph-builder-session-diagnostics">
          {preview.diagnostics.map((diagnostic) => (
            <li className={`graph-builder-session-diagnostic-${diagnostic.severity}`} key={diagnostic.diagnosticKey}>
              {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function GraphBuilderDeltaDetails({ delta }: { delta: GraphDraftDelta }) {
  const groups: { heading: string; items: { key: string; content: ReactNode }[] }[] = [];
  if (delta.addedNodes.length > 0) {
    groups.push({
      heading: 'Added nodes',
      items: delta.addedNodes.map((node) => ({
        key: node.nodeId,
        content: (
          <>
            {node.title || node.type} <span className="graph-builder-session-change-kind">({node.type})</span>
          </>
        ),
      })),
    });
  }
  if (delta.updatedNodes.length > 0) {
    groups.push({
      heading: 'Updated nodes',
      items: delta.updatedNodes.map((node) => ({
        key: node.nodeId,
        content: (
          <>
            {node.title || node.type} <span className="graph-builder-session-change-kind">({node.type})</span>{' '}
            <span className="graph-builder-session-change-fields">— {node.changedFields.join(', ')}</span>
          </>
        ),
      })),
    });
  }
  if (delta.removedNodes.length > 0) {
    groups.push({
      heading: 'Removed nodes',
      items: delta.removedNodes.map((node) => ({
        key: node.nodeId,
        content: (
          <>
            {node.title || node.type} <span className="graph-builder-session-change-kind">({node.type})</span>
          </>
        ),
      })),
    });
  }
  if (delta.addedConnections.length > 0) {
    groups.push({
      heading: 'Added connections',
      items: delta.addedConnections.map((connection) => ({
        key: connectionKey(connection),
        content: connectionLabel(connection),
      })),
    });
  }
  if (delta.removedConnections.length > 0) {
    groups.push({
      heading: 'Removed connections',
      items: delta.removedConnections.map((connection) => ({
        key: connectionKey(connection),
        content: connectionLabel(connection),
      })),
    });
  }

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="graph-builder-session-change-groups" aria-label="Graph draft changes">
      {groups.map((group) => (
        <div key={group.heading}>
          <div className="graph-builder-session-change-heading">{group.heading}</div>
          <ul className="graph-builder-session-change-list">
            {group.items.map((item) => (
              <li key={item.key}>{item.content}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function connectionLabel(connection: GraphDraftDelta['addedConnections'][number]): string {
  return `${connection.outputNodeId} / ${connection.outputId} → ${connection.inputNodeId} / ${connection.inputId}`;
}

function connectionKey(connection: GraphDraftDelta['addedConnections'][number]): string {
  return graphBuilderStringTupleKey(
    connection.outputNodeId,
    connection.outputId,
    connection.inputNodeId,
    connection.inputId,
  );
}

function terminalHeading(status: GraphBuilderSessionViewState['status']): string {
  switch (status) {
    case 'committed':
      return 'Graph change applied';
    case 'no-change':
      return 'No graph change needed';
    case 'cannot-complete':
      return 'Request cannot be completed';
    case 'discarded':
      return 'Draft discarded';
    case 'canceled':
      return 'Generation canceled';
    case 'failed':
      return 'Graph Builder stopped';
    case 'budget-exhausted':
      return 'Graph Builder budget exhausted';
    case 'conflicted':
      return 'The project changed';
    case 'expired':
      return 'Graph Builder session expired';
    default:
      return 'Graph Builder';
  }
}

function terminalMessage(result: Extract<GraphBuilderSessionViewState, { result: unknown }>['result']): string {
  switch (result.status) {
    case 'committed':
    case 'no-change':
      return result.summary;
    case 'cannot-complete':
      return result.reason;
    case 'discarded':
      return result.summary ?? 'The private draft was discarded without changing the project.';
    case 'canceled':
      return 'The private draft was discarded without changing the project.';
    case 'failed':
      return result.failure.userMessage;
    case 'budget-exhausted':
      return 'No changes were applied. Start over to approve a fresh session budget.';
    case 'conflicted':
      return 'The live project changed while the draft was being prepared. Start over from the current graph.';
    case 'expired':
      return 'The private draft expired without changing the project.';
  }
}
