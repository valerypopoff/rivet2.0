import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import { applyProcessEventToProjectExecutionSnapshot } from './projectExecutionSnapshotEvents.js';

/** Shared display safeguards, after transport-specific lifetime/root admission.
 * This never replaces authored definitions or owns execution lifecycle. */
type ProjectionCompatibility = {
  projectId: ProjectId;
  project: Project | undefined;
  message: string;
  data: unknown;
  dirty: boolean;
  notice(message: string): void;
};

export function checkRemoteExecutionCompatibility(options: ProjectionCompatibility): boolean {
  const { projectId, project, message, data, dirty, notice } = options;
  const event = data as {
    execution?: { projectId?: string; graphId?: string };
    node?: { id: string };
    graph?: { nodes: unknown[]; connections: unknown[] };
  } | null;
  if (event?.execution?.projectId === projectId && !['done', 'error', 'abort', 'pause', 'resume'].includes(message)) {
    const graph = project?.graphs[event.execution.graphId as GraphId];
    if (!graph || (event.node && !graph.nodes.some((node) => node.id === event.node!.id))) {
      notice(
        'The runtime graph differs from this editor. Missing graph/node data is not painted; save or open the matching project version.',
      );
      return false;
    }
    if (
      message === 'graphStart' &&
      (dirty ||
        JSON.stringify([graph.nodes, graph.connections]) !==
          JSON.stringify([event.graph?.nodes, event.graph?.connections]))
    )
      notice(
        'The runtime uses a saved graph that may differ from the current editor. Unsaved definitions were not changed.',
      );
  }
  return true;
}

export function projectRemoteExecutionEvent(
  options: Parameters<typeof applyProcessEventToProjectExecutionSnapshot>[0] &
    ProjectionCompatibility & {
      snapshot: NonNullable<Parameters<typeof applyProcessEventToProjectExecutionSnapshot>[0]['snapshot']>;
      clearFrozenOnGraphStart?: boolean;
    },
) {
  const { snapshot, message } = options;
  if (!checkRemoteExecutionCompatibility(options)) return snapshot;
  const result = applyProcessEventToProjectExecutionSnapshot(options).snapshot ?? snapshot;
  return options.clearFrozenOnGraphStart && message === 'graphStart' ? { ...result, frozenNodeOutputs: {} } : result;
}
