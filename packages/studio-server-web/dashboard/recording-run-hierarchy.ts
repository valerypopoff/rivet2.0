import type { WorkflowRecordingRunSummary } from './types';

export type RecordingRunFamily = {
  key: string;
  root: WorkflowRecordingRunSummary | null;
  children: WorkflowRecordingRunSummary[];
  childLoadState?: 'unloaded' | 'loading' | 'complete' | 'failed';
};

export type RecordingListRow = {
  id: string;
  recording: WorkflowRecordingRunSummary | null;
  family: RecordingRunFamily | null;
  isChild: boolean;
  expanded: boolean;
};

/** Group only actual results. Never invent an ancestor or treat a child as one.
 * Correlation identifies a root execution, not the immediate parent of a nested
 * Subgraph. Keep descendants at one level, oldest first, while preserving the
 * primary/context result order supplied by the paginated API.
 */
export function groupRecordingRuns(
  recordings: WorkflowRecordingRunSummary[],
  childLoadStates?: Readonly<Record<string, RecordingRunFamily['childLoadState']>>,
): RecordingRunFamily[] {
  const contextKeys = new Set(
    recordings.filter((run) => run.familyContext).map((run) => run.executionIdentity?.correlationId),
  );
  const uniqueRuns = [...new Map(recordings.map((run) => [run.id, run])).values()];
  const rootsByCorrelation = new Map<string, WorkflowRecordingRunSummary[]>();
  const childrenByCorrelation = new Map<string, WorkflowRecordingRunSummary[]>();
  for (const run of uniqueRuns) {
    const correlation = run.executionIdentity?.correlationId;
    if (!correlation?.trim()) continue;
    const index = run.executionIdentity?.surface === 'subgraph_project' ? childrenByCorrelation : rootsByCorrelation;
    const members = index.get(correlation) ?? [];
    members.push(run);
    index.set(correlation, members);
  }

  const families: RecordingRunFamily[] = [];
  const emitted = new Set<string>();
  for (const run of uniqueRuns) {
    if (emitted.has(run.id)) continue;
    const correlation = run.executionIdentity?.correlationId;
    const isChild = run.executionIdentity?.surface === 'subgraph_project';
    const roots = correlation ? rootsByCorrelation.get(correlation) ?? [] : [];
    const children = correlation?.trim() ? childrenByCorrelation.get(correlation) ?? [] : [];
    // Multiple primary recordings with one key are ambiguous. Leave the roots
    // independent, and group children without asserting a particular parent.
    const root = roots.length === 1 && !contextKeys.has(correlation) ? roots[0]! : null;
    const contextAnchor = children.find((child) => childLoadStates?.[child.id] != null) ?? children[0];
    const anchor = root ?? contextAnchor;
    const discoverChildren =
      childLoadStates != null &&
      anchor != null &&
      (isChild || root?.id === run.id) &&
      (isChild || children.length > 0 || (root?.hasSubRuns !== false && childLoadStates[anchor.id] !== 'complete'));
    if ((children.length > 0 || discoverChildren) && (isChild || root?.id === run.id)) {
      const family: RecordingRunFamily = {
        key: `correlation:${correlation}`,
        root,
        children,
        childLoadState: discoverChildren ? childLoadStates[anchor!.id] ?? 'unloaded' : undefined,
      };
      families.push(family);
      if (root) emitted.add(root.id);
      for (const child of children) emitted.add(child.id);
    } else {
      families.push({ key: `run:${run.id}`, root: isChild ? null : run, children: isChild ? [run] : [] });
      emitted.add(run.id);
    }
  }
  // Fetch pages are newest-first. Sort the complete display family once, not
  // individual pages or statuses, including context and input-search families.
  for (const family of families) {
    family.children.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  }
  return families;
}

/** Flatten expanded descendants for virtualization, not one giant DOM family. */
export function recordingHierarchyRows(
  families: RecordingRunFamily[],
  expandedKeys: ReadonlySet<string>,
): RecordingListRow[] {
  return families.flatMap((family) => {
    const expanded = expandedKeys.has(family.key);
    const rows: RecordingListRow[] = [
      {
        id: family.root ? `recording:${family.root.id}` : `family:${family.key}`,
        recording: family.root,
        family: family.children.length > 0 || family.childLoadState != null ? family : null,
        isChild: false,
        expanded,
      },
    ];
    if (expanded) {
      for (const recording of family.children) {
        rows.push({
          id: `recording:${recording.id}`,
          recording,
          family: null,
          isChild: true,
          expanded: false,
        });
      }
    }
    return rows;
  });
}

/** Measurements belong to row identities, while virtual offsets belong to
 * indexes. Invalidate changed rows even if regrouping also moved them.
 */
export function refreshRecordingRowMeasurements(
  previousRows: RecordingListRow[],
  nextRows: RecordingListRow[],
  heights: Map<string, number>,
): number | null {
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  const activeIds = new Set<string>();
  let firstChanged: number | null = null;
  for (const [index, next] of nextRows.entries()) {
    activeIds.add(next.id);
    const previous = previousById.get(next.id);
    const heightChanged =
      previous != null &&
      (previous.recording !== next.recording ||
        previous.expanded !== next.expanded ||
        previous.isChild !== next.isChild ||
        previous.family?.childLoadState !== next.family?.childLoadState ||
        previous.family?.children.length !== next.family?.children.length);
    if (heightChanged) heights.delete(next.id);
    if (firstChanged == null && (previousRows[index]?.id !== next.id || heightChanged)) firstChanged = index;
  }
  if (firstChanged == null && previousRows.length > nextRows.length) firstChanged = nextRows.length;
  for (const id of heights.keys()) {
    if (!activeIds.has(id)) heights.delete(id);
  }
  return firstChanged;
}
