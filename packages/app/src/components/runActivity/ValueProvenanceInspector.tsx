import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import type { FC } from 'react';
import { AppModalHeader } from '../AppModalHeader.js';
import type { ValueProvenanceInput, ValueProvenanceReport } from '../../features/runActivity/valueProvenance.js';

const valueProvenanceStyles = css`
  .run-value-provenance-intro,
  .run-value-provenance-notice {
    margin: 0 0 12px;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
  }

  .run-value-provenance-notice {
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--warning) 44%, var(--app-panel-border));
    border-radius: 7px;
    background: color-mix(in srgb, var(--warning) 7%, var(--modal-surface-bg));
  }

  .run-value-provenance-list,
  .run-value-provenance-children {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .run-value-provenance-children {
    margin: 8px 0 0 14px;
    padding-left: 12px;
    border-left: 1px solid var(--app-panel-border);
  }

  .run-value-provenance-entry {
    padding: 10px 12px;
    border: 1px solid var(--app-panel-border);
    border-radius: 7px;
    background: var(--node-body-bg, var(--app-panel-bg));
  }

  .run-value-provenance-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
  }

  .run-value-provenance-heading strong {
    color: var(--foreground);
  }

  .run-value-provenance-source,
  .run-value-provenance-message,
  .run-value-provenance-preview {
    overflow-wrap: anywhere;
  }

  .run-value-provenance-source,
  .run-value-provenance-message {
    margin-top: 5px;
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
  }

  .run-value-provenance-preview {
    display: block;
    margin-top: 7px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--code-editor-bg, color-mix(in srgb, var(--app-panel-bg) 88%, black));
    color: var(--foreground);
    font-family: var(--monospace-font-family, monospace);
    font-size: var(--ui-font-size-sm);
    white-space: pre-wrap;
  }

  .run-value-provenance-state {
    color: var(--foreground-dim);
    font-size: var(--ui-font-size-sm);
  }
`;

export const ValueProvenanceInspector: FC<{
  report: ValueProvenanceReport;
  onClose(): void;
}> = ({ report, onClose }) => (
  <ModalTransition>
    <Modal width="medium" onClose={onClose}>
      <AppModalHeader title={`Explain inputs: ${report.targetNodeTitle}`} onClose={onClose} />
      <ModalBody>
        <div css={valueProvenanceStyles}>
          <p className="run-value-provenance-intro">
            This view uses the selected run&apos;s recorded wiring when available, with current graph wiring only as a
            clearly marked legacy fallback. It reads existing execution values and does not retain a second copy of
            them.
          </p>
          {report.partialReason && <p className="run-value-provenance-notice">{report.partialReason}</p>}
          {report.inputs.length === 0 ? (
            <p className="run-value-provenance-intro">
              No connected or recorded inputs are available for this invocation.
            </p>
          ) : (
            <ul className="run-value-provenance-list">
              {report.inputs.map((input) => (
                <ProvenanceInput key={input.inputPortId} input={input} />
              ))}
            </ul>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  </ModalTransition>
);

const ProvenanceInput: FC<{ input: ValueProvenanceInput }> = ({ input }) => (
  <li className="run-value-provenance-entry">
    <div className="run-value-provenance-heading">
      <strong>{input.inputPortId}</strong>
      <span className="run-value-provenance-state">{describeState(input.state)}</span>
    </div>
    <div className="run-value-provenance-message">{input.message}</div>
    {input.valuePreview && <code className="run-value-provenance-preview">{input.valuePreview}</code>}
    {input.valuePreviewRedacted && (
      <div className="run-value-provenance-message">Value preview hidden because this port may contain a secret.</div>
    )}
    {input.source && (
      <>
        <div className="run-value-provenance-source">
          Producer: <strong>{input.source.nodeTitle}</strong> / {input.source.outputPortId}
          {input.source.processId && ` / process ${input.source.processId}`}
          {input.source.resultOrigin && ` / ${input.source.resultOrigin}`}
          {input.source.status && ` / ${input.source.status}`}
          {input.source.processId && ' / latest recorded producer before this invocation'}
        </div>
        {input.source.inputs && input.source.inputs.length > 0 && (
          <ul className="run-value-provenance-children">
            {input.source.inputs.map((child, index) => (
              <ProvenanceInput key={`${child.inputPortId}-${index}`} input={child} />
            ))}
          </ul>
        )}
      </>
    )}
  </li>
);

function describeState(state: ValueProvenanceInput['state']): string {
  const labels: Record<ValueProvenanceInput['state'], string> = {
    connected: 'connected',
    'source-invocation-unavailable': 'source invocation unavailable',
    unconnected: 'node setting or default',
    'not-supplied': 'not supplied',
    cycle: 'cycle detected',
    'depth-limit': 'trace limit reached',
  };
  return labels[state];
}
