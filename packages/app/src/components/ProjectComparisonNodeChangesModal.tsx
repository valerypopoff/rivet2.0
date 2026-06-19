import { type FC } from 'react';
import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import { css } from '@emotion/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { getProjectNodeFieldComparisons, type ProjectNodeFieldComparison } from '@valerypopoff/rivet2-core';
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diffStringsRaw } from 'jest-diff';
import * as yaml from 'yaml';
import {
  activeProjectComparisonState,
  resolveProjectCompareSideLabels,
  viewingProjectComparisonNodeState,
  type ResolvedProjectCompareSideLabels,
} from '../state/projectComparison.js';
import { AppModalHeader } from './AppModalHeader.js';

const PROJECT_COMPARE_NODE_CHANGES_MODAL_WIDTH = 'max(30vw, min(968px, calc(100vw - 48px)))';

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

  .project-compare-field-values {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1px;
    background: var(--settings-collapsible-border);
  }

  .project-compare-field-value {
    min-width: 0;
    padding: 10px 12px;
    background: var(--settings-collapsible-body-bg);
  }

  .project-compare-field-value-label {
    margin-bottom: 6px;
    color: var(--foreground-muted);
    font-size: var(--ui-font-size-xs);
    font-weight: 700;
  }

  .project-compare-diff-scroll-area {
    position: relative;
  }

  .project-compare-field-value pre {
    max-height: min(58vh, 720px);
    margin: 0;
    padding-right: 26px;
    color: var(--foreground);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    overflow: auto;
    scrollbar-gutter: stable;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .project-compare-value-diff {
    padding: 0 1px;
    border-radius: 3px;
    color: var(--foreground-bright);
  }

  .project-compare-value-diff-before {
    background: color-mix(in srgb, var(--error) 38%, transparent);
  }

  .project-compare-value-diff-after {
    background: color-mix(in srgb, var(--success) 34%, transparent);
  }

  .project-compare-diff-marker-track {
    position: absolute;
    top: 0;
    right: 14px;
    bottom: 0;
    width: 5px;
    pointer-events: none;
  }

  .project-compare-diff-marker {
    position: absolute;
    left: 0;
    right: 0;
    min-height: 4px;
    border-radius: 999px;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--grey-darker) 20%, transparent);
  }

  .project-compare-diff-marker-before {
    background: var(--error);
  }

  .project-compare-diff-marker-after {
    background: var(--success);
  }

  .project-compare-diff-empty {
    color: var(--foreground-muted);
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
    <div className="project-compare-field-values">
      <div className="project-compare-field-value">
        <div className="project-compare-field-value-label">{labels.referenceLabel}</div>
        <NodeFieldDiffValue side="before" before={fieldComparison.before} after={fieldComparison.after} />
      </div>
      <div className="project-compare-field-value">
        <div className="project-compare-field-value-label">{labels.currentLabel}</div>
        <NodeFieldDiffValue side="after" before={fieldComparison.before} after={fieldComparison.after} />
      </div>
    </div>
  </section>
);

const NodeFieldDiffValue: FC<{
  side: TextDiffSide;
  before: unknown;
  after: unknown;
}> = ({ side, before, after }) => {
  const beforeText = formatNodeFieldValue(before);
  const afterText = formatNodeFieldValue(after);
  const model = getTextDiffRenderModel(beforeText, afterText, side);

  return (
    <div className="project-compare-diff-scroll-area">
      <pre>
        {model.parts.length === 0 ? (
          <span className="project-compare-diff-empty">(no value on this side)</span>
        ) : (
          model.parts.map((part, index) =>
            part.changed ? (
              <mark key={index} className={`project-compare-value-diff project-compare-value-diff-${side}`}>
                {part.text}
              </mark>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )
        )}
      </pre>
      {model.markers.length > 0 && (
        <div className="project-compare-diff-marker-track" aria-hidden="true">
          {model.markers.map((marker, index) => (
            <span
              key={index}
              className={`project-compare-diff-marker project-compare-diff-marker-${side}`}
              style={{ top: `${marker.topPercent}%`, height: `${marker.heightPercent}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

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

type TextDiffSide = 'before' | 'after';

type TextDiffRenderPart = {
  changed: boolean;
  text: string;
};

type TextDiffMarker = {
  heightPercent: number;
  topPercent: number;
};

type TextDiffLineRange = {
  endLine: number;
  startLine: number;
};

function getTextDiffRenderModel(
  beforeText: string,
  afterText: string,
  side: TextDiffSide,
): { markers: TextDiffMarker[]; parts: TextDiffRenderPart[] } {
  const rawDiff = diffStringsRaw(beforeText, afterText, true);
  const sideText = side === 'before' ? beforeText : afterText;
  const lineStarts = getLineStarts(sideText);
  const parts: TextDiffRenderPart[] = [];
  const markerRanges: TextDiffLineRange[] = [];
  let beforeOffset = 0;
  let afterOffset = 0;

  for (const diffPart of rawDiff) {
    const operation = diffPart[0];
    const text = diffPart[1];

    if (operation === DIFF_EQUAL) {
      appendTextDiffPart(parts, { changed: false, text });
      beforeOffset += text.length;
      afterOffset += text.length;
      continue;
    }

    if (operation === DIFF_DELETE) {
      if (side === 'before') {
        appendTextDiffPart(parts, { changed: true, text });
        markerRanges.push(getChangedLineRange(lineStarts, beforeOffset, text.length));
      }
      beforeOffset += text.length;
      continue;
    }

    if (operation === DIFF_INSERT) {
      if (side === 'after') {
        appendTextDiffPart(parts, { changed: true, text });
        markerRanges.push(getChangedLineRange(lineStarts, afterOffset, text.length));
      }
      afterOffset += text.length;
    }
  }

  return {
    markers: getTextDiffMarkers(mergeTextDiffLineRanges(markerRanges), lineStarts.length),
    parts,
  };
}

function appendTextDiffPart(parts: TextDiffRenderPart[], part: TextDiffRenderPart): void {
  if (part.text.length === 0) {
    return;
  }

  const previousPart = parts.at(-1);
  if (previousPart && previousPart.changed === part.changed) {
    previousPart.text += part.text;
    return;
  }

  parts.push(part);
}

function getLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getChangedLineRange(lineStarts: readonly number[], startOffset: number, length: number): TextDiffLineRange {
  const endOffset = Math.max(startOffset, startOffset + length - 1);

  return {
    endLine: getLineIndexAtOffset(lineStarts, endOffset),
    startLine: getLineIndexAtOffset(lineStarts, startOffset),
  };
}

function getLineIndexAtOffset(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid] ?? 0;

    if (lineStart <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return Math.max(0, high);
}

function mergeTextDiffLineRanges(ranges: TextDiffLineRange[]): TextDiffLineRange[] {
  const sortedRanges = [...ranges].sort(
    (left, right) => left.startLine - right.startLine || left.endLine - right.endLine,
  );
  const mergedRanges: TextDiffLineRange[] = [];

  for (const range of sortedRanges) {
    const previousRange = mergedRanges.at(-1);

    if (previousRange && range.startLine <= previousRange.endLine + 1) {
      previousRange.endLine = Math.max(previousRange.endLine, range.endLine);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  return mergedRanges;
}

function getTextDiffMarkers(ranges: TextDiffLineRange[], lineCount: number): TextDiffMarker[] {
  const safeLineCount = Math.max(1, lineCount);

  return ranges.map((range) => {
    const lineSpan = Math.max(1, range.endLine - range.startLine + 1);

    return {
      heightPercent: Math.max(1.2, (lineSpan / safeLineCount) * 100),
      topPercent: (range.startLine / safeLineCount) * 100,
    };
  });
}
