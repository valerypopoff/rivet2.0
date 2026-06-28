import { lazy, Suspense, type FC } from 'react';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getProjectNodeFieldComparisons, type ProjectNodeFieldComparison } from '@valerypopoff/rivet2-core';
import * as yaml from 'yaml';
import {
  activeProjectComparisonState,
  resolveProjectCompareSideLabels,
  viewingProjectComparisonNodeState,
  type ResolvedProjectCompareSideLabels,
} from '../state/projectComparison.js';
import { AppModalHeader } from './AppModalHeader.js';

const PROJECT_COMPARE_NODE_CHANGES_MODAL_WIDTH = 'max(30vw, min(968px, calc(100vw - 48px)))';
const LazyProjectComparisonDiffEditor = lazy(() => import('./ProjectComparisonDiffEditor.js'));

const styles = css`
  display: flex;
  flex-direction: column;
  gap: 16px;

  .project-compare-node-meta {
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
  }

  .project-compare-field-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .project-compare-field {
    border: 1px solid var(--settings-collapsible-border);
    border-radius: 12px;
    corner-shape: squircle;
    overflow: hidden;
  }

  .project-compare-field-header {
    padding: 8px 12px;
    background: var(--settings-collapsible-header-bg);
    color: var(--foreground);
    font-weight: 700;
  }

  .project-compare-field-labels {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--settings-collapsible-border);
  }

  .project-compare-field-value-label {
    min-width: 0;
    padding: 10px 12px 6px;
    background: var(--settings-collapsible-body-bg);
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
  }

  .project-compare-field-diff {
    padding: 0 12px 12px;
    background: var(--settings-collapsible-body-bg);
  }

  .project-compare-diff-loading {
    align-items: center;
    color: var(--foreground-muted);
    display: flex;
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    min-height: 56px;
  }

`;

export const ProjectComparisonNodeChangesModalRenderer: FC = () => {
  const viewingNode = useAtomValue(viewingProjectComparisonNodeState);

  return <ModalTransition>{viewingNode == null ? null : <ProjectComparisonNodeChangesModal />}</ModalTransition>;
};

export const ProjectComparisonNodeChangesModal: FC = () => {
  const viewingNode = useAtomValue(viewingProjectComparisonNodeState);
  const activeComparison = useAtomValue(activeProjectComparisonState);
  const setViewingNode = useSetAtom(viewingProjectComparisonNodeState);

  const close = () => setViewingNode(undefined);

  if (!viewingNode || !activeComparison) {
    return null;
  }

  const nodeComparison = activeComparison.comparison.graphs[viewingNode.graphId]?.nodes[viewingNode.nodeId];
  if (!nodeComparison || nodeComparison.kind !== 'changed') {
    return null;
  }

  const fieldComparisons = getProjectNodeFieldComparisons(nodeComparison);
  const beforeTitle = nodeComparison.before?.title ?? nodeComparison.before?.type ?? viewingNode.nodeId;
  const afterTitle = nodeComparison.after?.title ?? nodeComparison.after?.type ?? viewingNode.nodeId;
  const labels = resolveProjectCompareSideLabels(activeComparison.labels);

  return (
    <Modal width={PROJECT_COMPARE_NODE_CHANGES_MODAL_WIDTH} autoFocus={false} onClose={close}>
      <AppModalHeader title="Node config changes" onClose={close} />
      <ModalBody>
        <div css={styles}>
          <div className="project-compare-node-meta">
            Comparing {labels.referenceLabel} node <strong>{String(beforeTitle)}</strong> to {labels.currentLabel} node{' '}
            <strong>{String(afterTitle)}</strong>.
          </div>
          {fieldComparisons.length === 0 ? (
            <div className="project-compare-node-meta">No node config attribute changes were found.</div>
          ) : (
            <div className="project-compare-field-list">
              {fieldComparisons.map((fieldComparison) => (
                <NodeFieldComparisonRow key={fieldComparison.field} fieldComparison={fieldComparison} labels={labels} />
              ))}
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button appearance="primary" onClick={close}>
          Done
        </Button>
      </ModalFooter>
    </Modal>
  );
};

const NodeFieldComparisonRow: FC<{
  fieldComparison: ProjectNodeFieldComparison;
  labels: ResolvedProjectCompareSideLabels;
}> = ({ fieldComparison, labels }) => (
  <section className="project-compare-field">
    <div className="project-compare-field-header">{getNodeFieldLabel(fieldComparison)}</div>
    <div className="project-compare-field-labels">
      <div className="project-compare-field-value-label">{labels.referenceLabel}</div>
      <div className="project-compare-field-value-label">{labels.currentLabel}</div>
    </div>
    <div className="project-compare-field-diff">
      <Suspense fallback={<div className="project-compare-diff-loading">Loading diff editor...</div>}>
        <LazyProjectComparisonDiffEditor
          previousText={formatNodeFieldValue(fieldComparison.before)}
          currentText={formatNodeFieldValue(fieldComparison.after)}
        />
      </Suspense>
    </div>
  </section>
);

function getNodeFieldLabel(fieldComparison: ProjectNodeFieldComparison): string {
  const [rootField, ...pathRest] = fieldComparison.path;
  const labels: Record<string, string> = {
    data: 'Node settings',
    description: 'Description',
    disabled: 'Disabled',
    isConditional: 'Conditional',
    isSplitRun: 'Split run',
    isSplitSequential: 'Sequential split run',
    splitRunConcurrency: 'Split run concurrency',
    splitRunMax: 'Split run max',
    tests: 'Tests',
    title: 'Title',
    type: 'Node type',
    variants: 'Variants',
    visualData: 'Visual placement',
  };

  const label = labels[rootField ?? fieldComparison.field] ?? rootField ?? fieldComparison.field;
  return pathRest.length > 0 ? `${label}: ${formatNodeFieldPath(pathRest)}` : label;
}

function formatNodeFieldValue(value: unknown): string {
  if (value === undefined) {
    return 'Not set';
  }

  if (typeof value === 'string') {
    return value.length > 0 ? value : '(empty string)';
  }

  return yaml.stringify(value).trimEnd();
}

function formatNodeFieldPath(path: readonly string[]): string {
  return path.reduce((formatted, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${formatted}[${segment}]`;
    }

    if (formatted.length === 0) {
      return segment;
    }

    return /^[A-Za-z_$][\w$]*$/.test(segment) ? `${formatted}.${segment}` : `${formatted}[${JSON.stringify(segment)}]`;
  }, '');
}
