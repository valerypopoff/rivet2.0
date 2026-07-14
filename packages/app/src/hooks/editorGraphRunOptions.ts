import type { GraphId, GraphInputs, GraphOutputs, GraphProgress, NodeId } from '@valerypopoff/rivet2-core';

export type EditorGraphRunOptions = {
  abortSignal?: AbortSignal;
  from?: NodeId;
  graphId?: GraphId;
  inputs?: GraphInputs;
  onProgress?: (progress: GraphProgress) => void;
  requireLiveRun?: boolean;
  throwOnError?: boolean;
  to?: NodeId[];
  waitForResults?: boolean;
};

export type EditorGraphRun = (options?: EditorGraphRunOptions) => Promise<GraphOutputs | undefined>;
