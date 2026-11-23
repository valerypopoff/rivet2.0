import { useCallback, useRef, useState } from 'react';
import { fetchRecordingSubRuns } from './workflowApi';
import type { WorkflowRecordingRunSummary } from './types';

export function useRecordingSubRuns(
  primaryRuns: WorkflowRecordingRunSummary[],
  selectedWorkflowId: string,
  viewVersion: Readonly<{ current: number }>,
) {
  const [subRuns, setSubRuns] = useState<WorkflowRecordingRunSummary[]>([]);
  const [childLoadStates, setChildLoadStates] = useState<Record<string, 'loading' | 'complete' | 'failed'>>({});
  const [childLoadErrors, setChildLoadErrors] = useState<Record<string, string>>({});
  const childRequestsRef = useRef(new Map<string, AbortController>());

  const abortPending = useCallback(() => {
    for (const request of childRequestsRef.current.values()) request.abort();
    childRequestsRef.current.clear();
  }, []);

  const resetForView = useCallback(() => {
    abortPending();
    setSubRuns([]);
    setChildLoadStates({});
    setChildLoadErrors({});
  }, [abortPending]);

  const reconcileDeletedRecording = useCallback(
    (recordingId: string, deletingRun: WorkflowRecordingRunSummary | undefined) => {
      setChildLoadErrors((errors) => {
        const next = { ...errors };
        delete next[recordingId];
        return next;
      });
      abortPending();
      setChildLoadStates((states) =>
        Object.fromEntries(Object.entries(states).map(([id, state]) => [id, state === 'loading' ? 'failed' : state])),
      );
      setSubRuns((currentRuns) =>
        currentRuns.filter(
          (run) =>
            run.id !== recordingId &&
            (deletingRun?.executionIdentity?.surface === 'subgraph_project' ||
              run.executionIdentity?.correlationId !== deletingRun?.executionIdentity?.correlationId),
        ),
      );
    },
    [abortPending],
  );

  const handleLoadSubRuns = useCallback(
    async (key: string) => {
      if (!key.startsWith('correlation:')) return;
      const candidates = primaryRuns.filter((run) => `correlation:${run.executionIdentity?.correlationId}` === key);
      const primaries = candidates.filter((run) => run.executionIdentity?.surface !== 'subgraph_project');
      const root =
        candidates.find((run) => run.familyContext) ??
        (primaries.length === 1
          ? primaries[0]
          : candidates.find((run) => run.executionIdentity?.surface === 'subgraph_project'));
      if (!root || childLoadStates[root.id] === 'complete' || childRequestsRef.current.has(root.id)) return;
      const controller = new AbortController();
      const version = viewVersion.current;
      childRequestsRef.current.set(root.id, controller);
      const isCurrent = () => !controller.signal.aborted && version === viewVersion.current;
      setChildLoadStates((states) => ({ ...states, [root.id]: 'loading' }));
      setChildLoadErrors((errors) => {
        const next = { ...errors };
        delete next[root.id];
        return next;
      });
      try {
        // Fetch metadata in bounded pages, not input artifacts or all history.
        // Publish complete families only; failed attempts can safely retry.
        const children = new Map<string, WorkflowRecordingRunSummary>();
        let expectedCount: number | undefined;
        for (let childPage = 1; ; childPage++) {
          const response = await fetchRecordingSubRuns(
            root.id,
            childPage,
            controller.signal,
            root.executionIdentity?.surface === 'subgraph_project'
              ? selectedWorkflowId === root.workflowId
                ? 'project'
                : 'all'
              : undefined,
          );
          if (!isCurrent()) return;
          if (
            response.workflowId !== root.id ||
            response.page !== childPage ||
            !Number.isSafeInteger(response.totalRuns) ||
            response.totalRuns < 0
          ) {
            throw new Error('Sub-run pagination returned the wrong recording or page.');
          }
          expectedCount ??= response.totalRuns;
          if (response.totalRuns !== expectedCount) {
            throw new Error('Sub-runs changed while loading. Retry to refresh the family.');
          }
          const previousCount = children.size;
          if (
            response.runs.some(
              (run) =>
                run.executionIdentity?.surface !== 'subgraph_project' ||
                run.executionIdentity.correlationId !== root.executionIdentity?.correlationId,
            )
          ) {
            throw new Error('Sub-run pagination returned an unrelated recording.');
          }
          for (const run of response.runs) children.set(run.id, run);
          if (
            children.size > expectedCount ||
            (response.hasMore && (children.size === previousCount || children.size >= expectedCount))
          ) {
            throw new Error('Sub-run pagination did not advance consistently.');
          }
          if (!response.hasMore) {
            if (children.size !== expectedCount) {
              throw new Error('Sub-run pagination was incomplete. Retry to refresh the family.');
            }
            break;
          }
        }
        if (!isCurrent()) return;
        setSubRuns((current) => [...new Map([...current, ...children.values()].map((run) => [run.id, run])).values()]);
        setChildLoadStates((states) => ({ ...states, [root.id]: 'complete' }));
      } catch (err) {
        if (isCurrent()) {
          setChildLoadStates((states) => ({ ...states, [root.id]: 'failed' }));
          setChildLoadErrors((errors) => ({
            ...errors,
            [root.id]: `Could not load sub-runs: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      } finally {
        if (childRequestsRef.current.get(root.id) === controller) childRequestsRef.current.delete(root.id);
      }
    },
    [primaryRuns, childLoadStates, selectedWorkflowId, viewVersion],
  );

  return {
    subRuns,
    childLoadStates,
    childLoadErrors,
    handleLoadSubRuns,
    resetForView,
    abortPending,
    reconcileDeletedRecording,
  };
}
