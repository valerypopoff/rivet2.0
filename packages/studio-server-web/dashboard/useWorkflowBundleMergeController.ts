import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import type {
  BundleMergeAction,
  BundleMergeChoices,
  BundleMergeDependency,
  BundleMergeGraphMapping,
  BundleMergePreview,
  BundleMergeProject,
  BundleMergeSuggestion,
} from '../../studio-server-shared/workflow-bundle-types';
import type { WorkflowFolderItem } from './types';
import type { LibraryMutationCompletion } from './workflowNamespaceReconciliation';
import { previewWorkflowBundleMerge, mergeWorkflowBundle } from './workflowApi';
import { MutationOutcomeUnknownError } from './workflowNamespaceMutations';
import { actionValue, applyBundleMergeSuggestions, dependencyValue, graphKey } from './bundleMerge';

const emptyChoices = (destinationBundleId = ''): BundleMergeChoices => ({
  destinationBundleId,
  actions: [],
  dependencies: [],
  graphs: [],
});

/** Owns one modal session's choices, reviewed authority and admitted mutation. */
export function useWorkflowBundleMergeController({
  source,
  initialDestinationBundleId,
  onClose,
  onStructuralMutation,
}: {
  source: WorkflowFolderItem;
  initialDestinationBundleId?: string;
  onClose(): void;
  onStructuralMutation: LibraryMutationCompletion;
}) {
  const [choices, setChoices] = useState<BundleMergeChoices>(() => emptyChoices(initialDestinationBundleId));
  const latest = useRef(choices);
  const [catalogs, setCatalogs] = useState<BundleMergePreview | null>(null);
  const [review, setReview] = useState<{ choices: BundleMergeChoices; value: BundleMergePreview } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [suggestions, setSuggestions] = useState<BundleMergeSuggestion[]>();
  const currentSuggestions = useRef<BundleMergeSuggestion[]>();
  const initializeChoices = useRef(true);
  const compareChanges = useRef(true);
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const pending = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController>();
  const trackSelect = useCallback((id: string, open: boolean) => {
    if (mounted.current) setOpenSelect((current) => (open ? id : current === id ? null : current));
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  const change = (next: BundleMergeChoices) => {
    if (pending.current || unknown) return;
    latest.current = next;
    abort.current?.abort();
    setChoices(next);
    setReview(null);
    setAcknowledged([]);
    setError('');
  };
  useEffect(() => {
    setReview(null);
    if (!choices.destinationBundleId || unknown) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    const timer = setTimeout(() => {
      void previewWorkflowBundleMerge(source.bundleId!, choices, controller.signal, compareChanges.current)
        .then((value) => {
          if (controller.signal.aborted || latest.current !== choices || pending.current) return;
          if (value.suggestions) {
            currentSuggestions.current = value.suggestions;
            setSuggestions(value.suggestions);
          }
          const next = applyBundleMergeSuggestions(
            choices,
            value,
            currentSuggestions.current,
            initializeChoices.current,
          );
          initializeChoices.current = false;
          compareChanges.current = false;
          setCatalogs(value);
          if (next !== choices) {
            change(next);
            return;
          }
          setReview({ choices, value });
          setLoading(false);
        })
        .catch((failure) => {
          if (controller.signal.aborted || latest.current !== choices) return;
          setError(failure instanceof Error ? failure.message : 'Could not review the merge.');
          setLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [choices, refresh, source.bundleId, unknown]);
  const preview = review?.choices === choices ? review.value : null;
  // Keep editable fields mounted while their next validation is pending.
  // Only preview, never this retained form metadata, authorizes a submission.
  const form = catalogs?.destination.bundleId === choices.destinationBundleId ? catalogs : null;
  const close = () => {
    if (pending.current) return;
    abort.current?.abort();
    onClose();
  };
  const submit = async () => {
    // Edits, refresh and close revoke authority before React updates the controls.
    if (
      pending.current ||
      abort.current?.signal.aborted ||
      unknown ||
      loading ||
      error ||
      !preview?.fingerprint ||
      latest.current !== review?.choices ||
      preview.warnings.some((warning) => !acknowledged.includes(warning.id))
    )
      return;
    pending.current = true;
    abort.current?.abort();
    setBusy(true);
    setError('');
    try {
      await mergeWorkflowBundle(
        source.bundleId!,
        {
          choices,
          fingerprint: preview.fingerprint,
          acknowledgedWarnings: acknowledged,
        },
        preview.source.namespaceId,
        preview.destination.namespaceId,
      );
      onStructuralMutation(
        'Merge completed, but the project list could not refresh. Refresh the tree; do not merge again.',
        (tree) => {
          if (tree) toast.success('Project changes merged into ' + preview.destination.relativePath + '.');
        },
      );
      if (mounted.current) onClose();
    } catch (failure) {
      if (failure instanceof MutationOutcomeUnknownError) {
        onStructuralMutation(failure.message);
        if (mounted.current) setUnknown(true);
      }
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : 'Could not merge the bundle.');
        setReview(null);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const updateAction = (project: BundleMergeProject, value: string) => {
    const previous = choices.actions.find((action) => action.sourceProjectId === project.projectId);
    if ((value || 'skip') === actionValue(previous)) return;
    let action: BundleMergeAction | undefined;
    if (value === 'add')
      action = { sourceProjectId: project.projectId, kind: 'add', relativePath: project.relativePath };
    else if (value.startsWith('replace:'))
      action = {
        sourceProjectId: project.projectId,
        kind: 'replace',
        targetProjectId: value.slice(8),
      };
    change({
      ...choices,
      actions: [
        ...choices.actions.filter((choice) => choice.sourceProjectId !== project.projectId),
        ...(action ? [action] : []),
      ],
      graphs: choices.graphs.filter((graph) => graph.sourceProjectId !== project.projectId),
    });
  };
  const updateDependency = (project: BundleMergeProject, value: string) => {
    const previous = choices.dependencies.find((choice) => choice.sourceProjectId === project.projectId);
    if (value === dependencyValue(previous)) return;
    let dependency: BundleMergeDependency | undefined;
    if (value === 'add')
      dependency = { sourceProjectId: project.projectId, kind: 'add', relativePath: project.relativePath };
    else if (value.startsWith('existing:'))
      dependency = {
        sourceProjectId: project.projectId,
        kind: 'existing',
        targetProjectId: value.slice(9),
      };
    change({
      ...choices,
      dependencies: [
        ...choices.dependencies.filter((choice) => choice.sourceProjectId !== project.projectId),
        ...(dependency ? [dependency] : []),
      ],
      graphs: choices.graphs.filter((graph) => graph.sourceProjectId !== project.projectId),
    });
  };
  const selectDestination = (destinationId: string) => {
    if (pending.current || unknown || destinationId === latest.current.destinationBundleId) return;
    initializeChoices.current = true;
    compareChanges.current = true;
    currentSuggestions.current = undefined;
    setSuggestions(undefined);
    setCatalogs(null);
    change(emptyChoices(destinationId));
  };
  const updateActionPath = (action: BundleMergeAction | undefined, value: string) =>
    change({
      ...choices,
      actions: choices.actions.map((choice) =>
        choice === action && choice.kind === 'add' ? { ...choice, relativePath: value } : choice,
      ),
    });
  const updateDependencyPath = (dependency: BundleMergeDependency | undefined, value: string) =>
    change({
      ...choices,
      dependencies: choices.dependencies.map((choice) =>
        choice === dependency && choice.kind === 'add' ? { ...choice, relativePath: value } : choice,
      ),
    });
  const selectGraph = (sourceProjectId: string, sourceGraphId: string, targetGraphId: string) => {
    const key = graphKey(sourceProjectId, sourceGraphId);
    change({
      ...choices,
      graphs: [
        ...choices.graphs.filter((choice) => graphKey(choice.sourceProjectId, choice.sourceGraphId) !== key),
        { sourceProjectId, sourceGraphId, targetGraphId },
      ],
    });
  };
  const clearGraph = (graph: BundleMergeGraphMapping) =>
    change({ ...choices, graphs: choices.graphs.filter((choice) => choice !== graph) });
  const setWarningAcknowledged = (id: string, checked: boolean) =>
    setAcknowledged(checked ? [...acknowledged, id] : acknowledged.filter((value) => value !== id));
  const refreshReview = () => {
    if (pending.current || unknown) return;
    abort.current?.abort();
    compareChanges.current = true;
    setReview(null);
    setAcknowledged([]);
    setRefresh((value) => value + 1);
  };

  const allAcknowledged = !!preview && preview.warnings.every((warning) => acknowledged.includes(warning.id));
  const canMerge = !busy && !loading && !unknown && !error && !!preview?.fingerprint && allAcknowledged;
  return {
    choices,
    form,
    preview,
    suggestions,
    error,
    loading,
    busy,
    unknown,
    acknowledged,
    openSelect,
    canMerge,
    selectDestination,
    updateAction,
    updateDependency,
    updateActionPath,
    updateDependencyPath,
    selectGraph,
    clearGraph,
    setWarningAcknowledged,
    refreshReview,
    submit,
    close,
    trackSelect,
  };
}
