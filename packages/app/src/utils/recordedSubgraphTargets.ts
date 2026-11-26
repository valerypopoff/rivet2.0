import {
  readSubgraphTargetDisplaySnapshots,
  type RecordedEvents,
  type SubGraphNode,
  type SubgraphTargetDisplaySnapshot,
} from '@valerypopoff/rivet2-core';

export type RecordedSubgraphTargetIndex = ReadonlyMap<string, SubgraphTargetDisplaySnapshot | null>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function owner(execution: Record<string, unknown> | undefined) {
  if (!nonempty(execution?.projectId)) return undefined;
  if (execution.projectScope !== undefined && !nonempty(execution.projectScope)) return undefined;
  return { projectId: execution.projectId, projectScope: execution.projectScope };
}

function targetKey(graphId: string, nodeId: string, projectId: string, version: string, targetGraphId: string) {
  return JSON.stringify([graphId, nodeId, projectId, version, targetGraphId]);
}

/** Build once for the selected recording, without consulting live project caches. */
export function buildRecordedSubgraphTargetIndex(events: readonly RecordedEvents[]): RecordedSubgraphTargetIndex {
  const index = new Map<string, SubgraphTargetDisplaySnapshot | null>();
  const start = events.find((event) => event?.type === 'start');
  const firstGraph = events.find((event) => event?.type === 'graphStart');
  let source;
  if (start) {
    const data = object(start.data);
    const execution = object(data?.execution);
    if (!nonempty(data?.projectId)) return index;
    if (execution?.projectId !== undefined && execution.projectId !== data.projectId) return index;
    if (execution?.projectScope !== undefined && !nonempty(execution.projectScope)) return index;
    source = { projectId: data.projectId, projectScope: execution?.projectScope };
  } else source = owner(object(object(firstGraph?.data)?.execution));
  if (!source) return index;

  for (const event of events) {
    if (event?.type !== 'graphStart') continue;
    const data = object(event.data);
    const eventOwner = owner(object(data?.execution));
    if (
      !eventOwner ||
      eventOwner.projectId !== source.projectId ||
      eventOwner.projectScope !== source.projectScope ||
      !nonempty(data?.graphId)
    )
      continue;
    for (const target of readSubgraphTargetDisplaySnapshots(data.subgraphTargets) ?? []) {
      const key = targetKey(
        data.graphId,
        target.nodeId,
        target.targetProjectId,
        target.targetVersion,
        target.targetGraphId,
      );
      const previous = index.get(key);
      if (previous === undefined) index.set(key, target);
      else if (
        previous !== null &&
        (previous.projectName !== target.projectName || previous.graphName !== target.graphName)
      ) {
        // Once conflicting, a later duplicate cannot make the evidence authoritative.
        index.set(key, null);
      }
    }
  }
  return index;
}

export function getRecordedSubgraphTarget(
  index: RecordedSubgraphTargetIndex | undefined,
  graphId: string | undefined,
  node: Pick<SubGraphNode, 'id' | 'data'>,
): SubgraphTargetDisplaySnapshot | undefined {
  const { targetProjectId, targetVersion = 'latest', graphId: targetGraphId } = node.data;
  if (!index || !graphId || !targetProjectId || !targetGraphId) return undefined;
  return index.get(targetKey(graphId, node.id, targetProjectId, targetVersion, targetGraphId)) ?? undefined;
}
