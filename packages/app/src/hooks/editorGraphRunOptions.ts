import type { GraphId, GraphInputs, GraphOutputs, NodeId } from '@valerypopoff/rivet2-core';

export type EditorGraphRunOptions = {
  from?: NodeId;
  graphId?: GraphId;
  inputs?: GraphInputs;
  requireLiveRun?: boolean;
  throwOnError?: boolean;
  to?: NodeId[];
  waitForResults?: boolean;
};

export type EditorGraphRun = (options?: EditorGraphRunOptions) => Promise<GraphOutputs | undefined>;
