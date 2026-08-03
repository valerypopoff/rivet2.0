import type { ReactNode } from 'react';
import type { GraphId, GraphRunId, NodeId, PortId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';
import type { RunActivityColumnWidths } from '../../features/runActivity/runActivityColumnWidths.js';

export type RunActivityStatus = 'idle' | 'running' | 'outputs-ready' | 'completed' | 'failed' | 'aborted';

export type RunActivityItemStatus = 'waiting' | 'running' | 'success' | 'error' | 'interrupted' | 'not-ran' | 'unknown';

export type RunActivityCategory = 'generic' | 'model' | 'tool' | 'error';

export type RunActivityFilter = 'all' | 'llm-tools' | 'errors';

export interface RunActivityGraphOption {
  graphId: GraphId;
  graphName: string;
}

export interface RunActivityAccountingSummary {
  modelCallCount: number;
  toolCallCount: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  knownCostUsd: number;
  costStatus: 'known' | 'partial' | 'unknown';
}

export interface RunActivityInvocationIdentity {
  rootRunId: RootRunId;
  graphRunId: GraphRunId;
  graphId: GraphId;
  nodeId: NodeId;
  processId: ProcessId;
}

export type RunActivityResultOriginView = 'executed' | 'preloaded' | 'frozen' | 'editor-cache' | 'unknown';

export interface RunActivityDetailRow {
  label: string;
  value: string;
}

/** Exact persisted Delegate output that produced one tool-call result. */
export type RunActivityToolResultTarget = RunActivityInvocationIdentity & {
  outputPortId: PortId;
};

export interface RunActivityChildViewModel {
  id: string;
  label: string;
  secondaryText?: string;
  status?: RunActivityItemStatus;
  durationMs?: number;
  /** Present only when this child has an exact Delegate Tool Call result owner. */
  toolResultTarget?: RunActivityToolResultTarget;
}

/**
 * Presentation-only representation of one exact node invocation. Runtime
 * Identities travel through the presentation unchanged so host actions can
 * select the exact graph run and process without guessing from timestamps.
 */
export interface RunActivityItemViewModel {
  activityKey: string;
  identity: RunActivityInvocationIdentity;
  sequence: number;
  graphId: GraphId;
  graphName: string;
  nodeTitle: string;
  nodeType: string;
  status: RunActivityItemStatus;
  category: RunActivityCategory;
  startedAt?: number;
  durationMs?: number;
  preview?: string;
  error?: string;
  splitCount?: number;
  provider?: string;
  model?: string;
  toolName?: string;
  modelCallCount?: number;
  toolCallCount?: number;
  detailRows?: RunActivityDetailRow[];
  children?: RunActivityChildViewModel[];
  /** Additional metadata aliases searched without searching large value previews. */
  searchTerms?: string[];
  navigable?: boolean;
  fullOutputAvailable?: boolean;
  /** Contextual name for the node-owned full-output action. */
  fullOutputActionLabel?: string;
  inspectable?: boolean;
  /** Lets Errors include failed child model/tool attempts without mislabelling the node result itself. */
  hasErrors?: boolean;
  resultOrigin: RunActivityResultOriginView;
}

export interface RunActivityViewModel {
  /** Exact root identity lets stateful views reset follow/expansion state when a new run replaces the previous one. */
  rootRunId?: RootRunId;
  status: RunActivityStatus;
  items: RunActivityItemViewModel[];
  durationMs?: number;
  startedAt?: number;
  outputsReadyAt?: number;
  backgroundWorkPending?: boolean;
  accounting?: RunActivityAccountingSummary;
  graphOptions?: RunActivityGraphOption[];
  omittedItemCount?: number;
  /** Truthful explanation for incomplete legacy, replay, or evicted run data. */
  partialReason?: string;
}

export interface RunActivityDrawerProps {
  open: boolean;
  viewModel: RunActivityViewModel;
  onClose(): void;
  onLocate?(item: RunActivityItemViewModel): void;
  onOpenFullOutput?(item: RunActivityItemViewModel): void;
  onOpenToolResult?(target: RunActivityToolResultTarget): void;
  onInspectResponse?(item: RunActivityItemViewModel): void;
  onCopyDiagnostics?(): void;
  height?: number;
  onHeightChange?(height: number): void;
  /** User-local desktop column preferences, owned by the renderer rather than the drawer. */
  columnWidths?: RunActivityColumnWidths;
  onColumnWidthsChange?(widths: RunActivityColumnWidths): void;
  /** Lets the host render rich, lazily resolved output without coupling this component to execution atoms. */
  renderExpandedContent?(item: RunActivityItemViewModel): ReactNode;
  className?: string;
}
