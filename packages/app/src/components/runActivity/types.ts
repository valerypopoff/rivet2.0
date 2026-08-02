import type { ReactNode } from 'react';
import type { GraphId, GraphRunId, NodeId, ProcessId, RootRunId } from '@valerypopoff/rivet2-core';

export type RunActivityStatus = 'idle' | 'running' | 'outputs-ready' | 'completed' | 'failed' | 'aborted';

export type RunActivityItemStatus = 'running' | 'success' | 'error' | 'interrupted' | 'not-ran' | 'unknown';

export type RunActivityCategory = 'generic' | 'model' | 'tool' | 'error';

export type RunActivityFilter = 'all' | 'llm-tools' | 'errors';

export interface RunActivityGraphOption {
  graphId: GraphId;
  graphName: string;
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

export interface RunActivityChildViewModel {
  id: string;
  label: string;
  secondaryText?: string;
  status?: RunActivityItemStatus;
  durationMs?: number;
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
  onInspectResponse?(item: RunActivityItemViewModel): void;
  onCopyDiagnostics?(): void;
  height?: number;
  onHeightChange?(height: number): void;
  /** Lets the host render rich, lazily resolved output without coupling this component to execution atoms. */
  renderExpandedContent?(item: RunActivityItemViewModel): ReactNode;
  className?: string;
}
