import type { GraphInvocationState } from './GraphExecutionState.js';
import type { GraphRunId } from './ProcessContext.js';

type Identity = Pick<GraphInvocationState, 'rootRunId' | 'graphRunId' | 'parentGraphRunId'>;
type RunState = Pick<GraphInvocationState, 'attachedNodeData' | 'graphInputNodeValues' | 'graphOutputs'>;

/** Same-graph branches are not ordinary subgraphs. Their aliasing rules are
 * deliberate: continuations commit overlays, async branches share inputs but
 * never seed parent outputs, and watch snapshots isolate mutable node state. */
export type ChildInvocationMode =
  | { kind: 'continuation'; graphOutputs: RunState['graphOutputs'] }
  | { kind: 'async' }
  | { kind: 'watch'; graphRunId: GraphRunId };

export function resolveChildInvocationOwnership<Owner>(
  mode: ChildInvocationMode,
  context: {
    parent: Owner;
    root: Owner;
    abortOwner: Owner;
    sameGraphOwner: Owner;
    rootGraphOrigin: boolean;
    run: RunState & Identity;
    rootIdentity: Identity;
    sameGraphIdentity: Identity;
    newGraphRunId(): GraphRunId;
  },
): {
  parent: Owner;
  abortOwner: Owner;
  sameGraphOwner?: Owner;
  suppressPartialOutputs: boolean;
  suppressLifecycle: boolean;
  state: RunState;
  identity: Identity;
} {
  const { run } = context;
  switch (mode.kind) {
    case 'continuation':
      return {
        parent: context.parent,
        abortOwner: context.abortOwner,
        sameGraphOwner: context.sameGraphOwner,
        suppressPartialOutputs: false,
        suppressLifecycle: true,
        state: {
          attachedNodeData: run.attachedNodeData,
          graphInputNodeValues: run.graphInputNodeValues,
          graphOutputs: mode.graphOutputs,
        },
        identity: { rootRunId: run.rootRunId, graphRunId: run.graphRunId, parentGraphRunId: run.parentGraphRunId },
      };
    case 'async':
      return {
        parent: context.sameGraphOwner,
        abortOwner: context.root,
        suppressPartialOutputs: true,
        suppressLifecycle: context.rootGraphOrigin,
        state: {
          attachedNodeData: run.attachedNodeData,
          graphInputNodeValues: run.graphInputNodeValues,
          graphOutputs: {},
        },
        identity: context.rootGraphOrigin
          ? { rootRunId: run.rootRunId, graphRunId: run.graphRunId, parentGraphRunId: run.parentGraphRunId }
          : {
              rootRunId: context.rootIdentity.rootRunId,
              graphRunId: context.newGraphRunId(),
              parentGraphRunId: context.sameGraphIdentity.graphRunId,
            },
      };
    case 'watch':
      return {
        parent: context.parent,
        abortOwner: context.root,
        suppressPartialOutputs: true,
        suppressLifecycle: true,
        state: { attachedNodeData: new Map(), graphInputNodeValues: { ...run.graphInputNodeValues }, graphOutputs: {} },
        identity: {
          rootRunId: context.rootIdentity.rootRunId,
          graphRunId: mode.graphRunId,
          parentGraphRunId: run.graphRunId,
        },
      };
  }
}
