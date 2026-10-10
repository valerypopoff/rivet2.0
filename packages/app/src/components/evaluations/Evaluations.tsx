import Button from '@atlaskit/button';
import type { GraphInputNode, Project } from '@valerypopoff/rivet2-core';
import {
  getEvaluationSuiteMode,
  hasAuthoritativeEvaluationCriteria,
  type EvaluationDataset,
  type EvaluationRunSummary as EvaluationHistoryEntry,
  type EvaluationRun,
  type EvaluationRunPurpose,
  type EvaluationSuite,
  type PortableJson,
} from '@valerypopoff/rivet2-evaluations';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { nanoid } from 'nanoid/non-secure';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FC } from 'react';
import { toast } from 'react-toastify';
import { useLoadRecording } from '../../hooks/useLoadRecording.js';
import { useEvaluationRunStore, useIOProvider } from '../../providers/ProvidersContext.js';
import {
  evaluationsState,
  getEvaluationRunHistoryScopeKey,
  getEvaluationSuitePresentation,
  isEvaluationRunHistoryCached,
  selectEvaluationDatasetResource,
  selectEvaluationSuiteResource,
  updateEvaluationSuitePresentation,
  type EvaluationRunHistoryScope,
  type EvaluationSuitePresentation,
} from '../../state/evaluations.js';
import { graphState } from '../../state/graph.js';
import { projectsState, projectState } from '../../state/savedGraphs.js';
import { overlayOpenState } from '../../state/ui.js';
import { CreateEvaluationSuiteModal, type CreateEvaluationSuiteValue } from './CreateEvaluationSuiteModal.js';
import { EvaluationConfirmModal, type EvaluationConfirmation } from './EvaluationConfirmModal.js';
import { EvaluationSectionTabs } from './EvaluationSectionTabs.js';
import { EvaluationSuiteRunStatus, getEvaluationSuiteWarnings } from './EvaluationSuiteRunStatus.js';
import { EvaluationSuiteSidebar } from './EvaluationSuiteSidebar.js';
import type { AbortEvaluation, TryRetryInterruptedEvaluation, TryRunEvaluation } from './api.js';
import { createEvaluationRunCommands } from './evaluationRunCommands.js';
import {
  addEvaluationDataset,
  addEvaluationSuite,
  assignEvaluationSuiteResource,
  createDataset,
  createStandaloneDataset,
  createSuite,
  removeEvaluationField,
  removeEvaluationResources,
} from './evaluationLibraryCommands.js';
import { createEvaluationTransferCommands } from './evaluationTransferCommands.js';
import {
  canCompareEvaluationSuite,
  getEvaluationAssertionAuthoringIssue,
  getEvaluationDatasetValueTypeAuthoringIssues,
  getEvaluationEvaluatorAuthoringIssue,
  getEvaluationExecutionConfigurationAuthoringIssues,
  getEvaluationExpectedValueAuthoringIssues,
  getEvaluationInputBindingAuthoringIssues,
  getEvaluationRunHistoryPresentation,
  getEvaluationSuiteReferenceStatus,
  getEvaluationTargetOutputs,
  getEvaluationThresholdAuthoringIssue,
  resolveComparableEvaluationRun,
  resolveEvaluationDataset,
  resolvePromptDesignerEvaluationProject,
  resolveSelectedEvaluationSuite,
  type EvaluationScoreSort,
  type EvaluationWorkspaceView,
} from './evaluationWorkspaceModel.js';
import { useEvaluationHistory } from './useEvaluationHistory.js';

import { Compare } from './EvaluationCompareView.js';
import { Dataset } from './EvaluationDatasetView.js';
import { Definition } from './EvaluationDefinitionView.js';
import { Runs } from './EvaluationRunsView.js';
import { ResourceTitle, styles } from './evaluationPresentation.js';

export const EvaluationsRenderer: FC<{
  tryRunEvaluation: TryRunEvaluation;
  retryInterruptedEvaluation: TryRetryInterruptedEvaluation;
  abortEvaluation: AbortEvaluation;
}> = ({ tryRunEvaluation, abortEvaluation, retryInterruptedEvaluation }) => {
  const openOverlay = useAtomValue(overlayOpenState);
  if (openOverlay !== 'evaluations') return null;
  return (
    <EvaluationsContainer
      tryRunEvaluation={tryRunEvaluation}
      retryInterruptedEvaluation={retryInterruptedEvaluation}
      abortEvaluation={abortEvaluation}
    />
  );
};

const EvaluationsContainer: FC<{
  tryRunEvaluation: TryRunEvaluation;
  retryInterruptedEvaluation: TryRetryInterruptedEvaluation;
  abortEvaluation: AbortEvaluation;
}> = ({ tryRunEvaluation, abortEvaluation, retryInterruptedEvaluation }) => {
  const [state, setState] = useAtom(evaluationsState);
  const storedProject = useAtomValue(projectState);
  const openedProjects = useAtomValue(projectsState);
  const projectAvailable = openedProjects.openedProjects[storedProject.metadata.id] !== undefined;
  // The persisted project atom intentionally outlives an open tab. Never use
  // its stale graphs when Evaluations is opened from Rivet's welcome screen.
  const project = projectAvailable ? storedProject : ({ ...storedProject, graphs: {} } as Project);
  const commandScope = useRef<{
    projectId: Project['metadata']['id'];
    suiteId?: string;
    mounted: boolean;
    revision: number;
  }>({
    projectId: project.metadata.id,
    mounted: true,
    revision: 0,
  });
  if (
    commandScope.current.projectId !== project.metadata.id ||
    commandScope.current.suiteId !== state.selectedSuiteId
  ) {
    commandScope.current.revision += 1;
  }
  commandScope.current.projectId = project.metadata.id;
  commandScope.current.suiteId = state.selectedSuiteId;
  useEffect(() => {
    const scope = commandScope.current;
    scope.mounted = true;
    return () => {
      scope.mounted = false;
    };
  }, []);
  const runStore = useEvaluationRunStore();
  const io = useIOProvider();
  const { loadSerializedRecording } = useLoadRecording();
  const graph = useAtomValue(graphState);
  const setOpenOverlay = useSetAtom(overlayOpenState);
  const view = state.activeView ?? 'definition';
  const setView = useCallback(
    (nextView: EvaluationWorkspaceView) =>
      setState((current) => {
        let next = current.activeView === nextView ? current : { ...current, activeView: nextView };
        if (nextView !== 'dataset' && current.selectedSuiteId) {
          next = updateEvaluationSuitePresentation(
            next,
            { projectId: project.metadata.id, suiteId: current.selectedSuiteId },
            { activeView: nextView },
          );
        }
        return next;
      }),
    [project.metadata.id, setState],
  );
  const [createSuiteOpen, setCreateSuiteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<EvaluationConfirmation>();
  const [hasInvalidDatasetDraft, setHasInvalidDatasetDraft] = useState(false);
  const [renamingDatasetId, setRenamingDatasetId] = useState<string>();
  const [renamingSuiteId, setRenamingSuiteId] = useState<string>();
  const [datasetUsageExpanded, setDatasetUsageExpanded] = useState(false);
  const [retryingHostedRunId, setRetryingHostedRunId] = useState<string>();
  const evaluationMainRef = useRef<HTMLElement>(null);
  const runScrollTopRef = useRef(0);
  const restoredRunScrollScopeRef = useRef<string>();
  const selectedSuite = resolveSelectedEvaluationSuite(state.data.suites, state.selectedSuiteId);
  const selectedSuiteId = selectedSuite?.id;
  const suitePresentationScope = useMemo<EvaluationRunHistoryScope | undefined>(
    () => (selectedSuiteId ? { projectId: project.metadata.id, suiteId: selectedSuiteId } : undefined),
    [project.metadata.id, selectedSuiteId],
  );
  const runHistoryScope = useMemo<EvaluationRunHistoryScope | undefined>(
    () =>
      selectedSuiteId && projectAvailable ? { projectId: project.metadata.id, suiteId: selectedSuiteId } : undefined,
    [project.metadata.id, projectAvailable, selectedSuiteId],
  );
  const runHistoryProjectId = runHistoryScope?.projectId;
  const runHistorySuiteId = runHistoryScope?.suiteId;
  const runHistoryScopeKey = runHistoryScope ? getEvaluationRunHistoryScopeKey(runHistoryScope) : undefined;
  const suitePresentation = getEvaluationSuitePresentation(state, suitePresentationScope);
  const hasCachedRunHistory = isEvaluationRunHistoryCached(state, runHistoryScope);
  const visibleRunTrialExpansion =
    state.runTrialExpansion?.scope.projectId === runHistoryProjectId &&
    state.runTrialExpansion?.scope.suiteId === runHistorySuiteId
      ? state.runTrialExpansion
      : undefined;
  const runScoreSort: EvaluationScoreSort = runHistoryScopeKey
    ? state.runScoreSortByScope[runHistoryScopeKey] ?? 'default'
    : 'default';
  const localDatasets = state.datasets;
  const selectedDataset = resolveEvaluationDataset(state.datasets, state.selectedDatasetId);
  const selectedDatasetSuites = selectedDataset
    ? state.data.suites.filter((suite) => suite.datasetId === selectedDataset.id)
    : [];
  // A project saved by an older editor can retain both selections. The active
  // view still disambiguates it; new navigation always selects exactly one
  // peer resource.
  const showingDataset = selectedDataset != null && (view === 'dataset' || selectedSuite == null);
  const suiteDataset = resolveEvaluationDataset(state.datasets, selectedSuite?.datasetId);
  const graphOptions = useMemo(
    () =>
      Object.values(project.graphs)
        .map((candidate) => ({
          label: candidate.metadata?.name ?? candidate.metadata?.id ?? 'Unnamed graph',
          value: candidate.metadata?.id ?? '',
        }))
        .filter((option) => option.value !== ''),
    [project.graphs],
  );
  const referenceStatus = selectedSuite
    ? getEvaluationSuiteReferenceStatus(selectedSuite, project, state.datasets)
    : undefined;
  const suiteRuns = useMemo(
    () =>
      selectedSuiteId && projectAvailable
        ? state.runs.filter((run) => run.projectId === project.metadata.id && run.suiteId === selectedSuiteId)
        : [],
    [selectedSuiteId, state.runs, project.metadata.id, projectAvailable],
  );
  const suiteCurrentRun =
    projectAvailable &&
    state.currentRun?.projectId === project.metadata.id &&
    state.currentRun.suiteId === selectedSuite?.id
      ? state.currentRun
      : undefined;
  const suiteHistoryEntries = useMemo(() => {
    const entries = new Map<string, EvaluationHistoryEntry>();
    if (hasCachedRunHistory)
      for (const entry of state.runHistoryEntries ?? [])
        if (entry.projectId === project.metadata.id && entry.suiteId === selectedSuiteId) entries.set(entry.id, entry);
    for (const run of suiteRuns) entries.set(run.id, run);
    if (suiteCurrentRun) entries.set(suiteCurrentRun.id, suiteCurrentRun);
    return [...entries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }, [hasCachedRunHistory, state.runHistoryEntries, suiteRuns, suiteCurrentRun, selectedSuiteId, project.metadata.id]);
  const suiteBaseline = useMemo(
    () =>
      selectedSuiteId ? state.data.baselines.find((candidate) => candidate.suiteId === selectedSuiteId) : undefined,
    [selectedSuiteId, state.data.baselines],
  );
  const compareAvailable = useMemo(
    () => (selectedSuiteId ? canCompareEvaluationSuite(selectedSuiteId, suiteRuns, state.data.baselines) : false),
    [selectedSuiteId, state.data.baselines, suiteRuns],
  );
  const comparableRun = useMemo(
    () =>
      selectedSuiteId
        ? state.selectedRunId &&
          !suiteRuns.some((run) => run.id === state.selectedRunId) &&
          suiteCurrentRun?.id !== state.selectedRunId
          ? undefined
          : resolveComparableEvaluationRun(selectedSuiteId, suiteRuns, state.selectedRunId, suiteCurrentRun)
        : undefined,
    [selectedSuiteId, state.selectedRunId, suiteCurrentRun, suiteRuns],
  );

  useEffect(() => {
    setRenamingSuiteId(undefined);
  }, [selectedSuiteId]);

  useEffect(() => {
    setRenamingDatasetId(undefined);
    setDatasetUsageExpanded(false);
  }, [selectedDataset?.id]);

  const updateSuite = (update: (suite: EvaluationSuite) => EvaluationSuite) =>
    setState((current) => ({
      ...current,
      data: {
        ...current.data,
        suites: current.data.suites.map((suite) => (suite.id === selectedSuite?.id ? update(suite) : suite)),
      },
    }));

  const updateSelectedSuitePresentation = useCallback(
    (update: Partial<EvaluationSuitePresentation>) => {
      if (!suitePresentationScope) return;
      setState((current) => updateEvaluationSuitePresentation(current, suitePresentationScope, update));
    },
    [setState, suitePresentationScope],
  );

  const addSuite = ({ datasetId, graphId, name }: CreateEvaluationSuiteValue) =>
    setState((current) => {
      const existingDataset =
        datasetId == null ? undefined : current.datasets.find((dataset) => dataset.id === datasetId);
      if (datasetId != null && !existingDataset) {
        toast.warn('The selected evaluation dataset no longer exists.');
        return current;
      }
      const dataset = existingDataset ?? createDataset(name);
      const suite = createSuite(dataset, graphId, name);
      return addEvaluationSuite(current, suite, existingDataset ? undefined : dataset).state;
    });

  const createSuiteFromDialog = (value: CreateEvaluationSuiteValue) => {
    addSuite(value);
    setCreateSuiteOpen(false);
    setView('definition');
  };

  const deleteEvaluationResources = ({ suiteIds, datasetId }: { suiteIds: readonly string[]; datasetId?: string }) => {
    let deletionWasBlocked = false;

    setState((current) => {
      const outcome = removeEvaluationResources(current, { suiteIds, datasetId });
      deletionWasBlocked = outcome.blocked;
      return outcome.state;
    });
    if (deletionWasBlocked) {
      toast.warn('Stop the running evaluation before deleting its suite or dataset.');
      return;
    }
  };

  const requestDeleteSuite = (suiteId: string) => {
    const suite = state.data.suites.find((candidate) => candidate.id === suiteId);
    if (!suite) return;
    if (state.runningSuiteId === suiteId) {
      toast.warn('Stop the running evaluation before deleting its suite.');
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Delete evaluation suite?',
      description: `Delete "${suite.name || 'Untitled evaluation suite'}"? Its baselines will be removed. Run history belongs to each project and is retained.`,
      confirmLabel: 'Delete suite',
      onConfirm: () => deleteEvaluationResources({ suiteIds: [suiteId] }),
    });
  };

  const requestDeleteDataset = (datasetId: string) => {
    const dataset = state.datasets.find((candidate) => candidate.id === datasetId);
    if (!dataset) return;
    const dependentSuites = state.data.suites.filter((suite) => suite.datasetId === datasetId);
    if (dependentSuites.some((suite) => suite.id === state.runningSuiteId)) {
      toast.warn('Stop the running evaluation before deleting its dataset.');
      return;
    }
    const dependentSuiteIds = dependentSuites.map((suite) => suite.id);
    const dependentDescription =
      dependentSuiteIds.length === 0
        ? ''
        : ` It is used by ${dependentSuiteIds.length} evaluation suite${dependentSuiteIds.length === 1 ? '' : 's'}, which will also be deleted with their baselines. Run history remains with each project.`;
    setConfirmation({
      appearance: 'danger',
      title: dependentSuiteIds.length > 0 ? 'Delete dataset and dependent suites?' : 'Delete evaluation dataset?',
      description: `Delete "${dataset.name || 'Untitled evaluation dataset'}"?${dependentDescription}`,
      confirmLabel: dependentSuiteIds.length > 0 ? 'Delete dataset and suites' : 'Delete dataset',
      onConfirm: () => deleteEvaluationResources({ suiteIds: dependentSuiteIds, datasetId }),
    });
  };

  const selectSuite = (suiteId: string) => {
    const scope: EvaluationRunHistoryScope = { projectId: project.metadata.id, suiteId };
    setState((current) => {
      const cachedSuiteRuns = isEvaluationRunHistoryCached(current, scope)
        ? current.runs.filter((run) => run.suiteId === suiteId)
        : [];
      return selectEvaluationSuiteResource(
        current,
        scope,
        canCompareEvaluationSuite(suiteId, cachedSuiteRuns, current.data.baselines),
      );
    });
  };

  const selectDataset = (datasetId: string) => {
    setState((current) => selectEvaluationDatasetResource(current, datasetId));
  };

  const createDatasetResource = () => {
    const dataset = createStandaloneDataset();
    setState((current) => addEvaluationDataset(current, dataset).state);
  };

  const transferCommands = createEvaluationTransferCommands({
    io,
    setState,
    isCurrent: () => isCommandScopeCurrent(),
    onNotice: ({ kind, message }) => {
      if (!isCommandScopeCurrent()) return;
      if (kind === 'success') toast.success(message);
      else toast.error(message);
    },
  });
  const importDatasetResource = () => {
    void transferCommands.importDataset();
  };
  const importSuiteResource = () => {
    void transferCommands.importSuite();
  };

  const addCase = (sourceDataset: EvaluationDataset) => {
    const testCase = {
      id: nanoid(),
      name: `Case ${sourceDataset.cases.length + 1}`,
      enabled: true,
      values: {} as Record<string, PortableJson>,
    };
    setState((current) => ({
      ...current,
      datasets: current.datasets.map((dataset) =>
        dataset.id === sourceDataset.id ? { ...dataset, cases: [...dataset.cases, testCase] } : dataset,
      ),
    }));
  };

  const commitRemoveDatasetField = (datasetId: string, fieldId: string) => {
    setState((current) => {
      const outcome = removeEvaluationField(current, datasetId, fieldId);
      if (outcome.message) toast.warn(outcome.message);
      return outcome.state;
    });
  };

  const requestRemoveDatasetField = (datasetId: string, fieldId: string) => {
    const dataset = resolveEvaluationDataset(state.datasets, datasetId);
    const field = dataset?.fields.find((candidate) => candidate.id === fieldId);
    if (!dataset || !field) return;
    const affectedSuites = state.data.suites.filter(
      (suite) =>
        suite.datasetId === dataset.id &&
        (suite.inputBindings.some((binding) => binding.datasetFieldId === fieldId) ||
          suite.assertions.some(
            (assertion) => assertion.expected.kind === 'dataset-field' && assertion.expected.fieldId === fieldId,
          ) ||
          suite.evaluators.some((evaluator) =>
            evaluator.inputBindings?.some(
              (binding) => binding.source.kind === 'dataset-field' && binding.source.fieldId === fieldId,
            ),
          )),
    );
    if (affectedSuites.some((suite) => suite.id === state.runningSuiteId)) {
      toast.warn('Stop the evaluation using this field before removing it.');
      return;
    }
    const remove = () => commitRemoveDatasetField(dataset.id, fieldId);
    if (affectedSuites.length === 0) {
      remove();
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Remove dataset field and suite bindings?',
      description: `Removing "${field.name || 'Untitled field'}" also clears its target-input, deterministic-check, and evaluator bindings from ${affectedSuites.length} evaluation suite${affectedSuites.length === 1 ? '' : 's'}.`,
      confirmLabel: 'Remove field',
      onConfirm: remove,
    });
  };

  const assignSuiteDataset = (datasetId: string) => {
    if (!selectedSuite || datasetId === selectedSuite.datasetId) return;
    if (resolveEvaluationDataset(state.datasets, datasetId) == null) {
      toast.error('Choose an evaluation dataset from the local evaluation library.');
      return;
    }
    const hasDatasetContracts =
      selectedSuite.inputBindings.length > 0 ||
      selectedSuite.assertions.some((assertion) => assertion.expected.kind === 'dataset-field') ||
      selectedSuite.evaluators.some((evaluator) =>
        evaluator.inputBindings?.some((binding) => binding.source.kind === 'dataset-field'),
      );
    if (hasDatasetContracts) {
      setConfirmation({
        title: 'Change evaluation dataset?',
        description:
          'Changing the dataset clears target and evaluator bindings that use dataset fields, and replaces deterministic-check references with null literals.',
        confirmLabel: 'Change dataset',
        onConfirm: () => commitSuiteDatasetAssignment(selectedSuite.id, datasetId),
      });
      return;
    }
    commitSuiteDatasetAssignment(selectedSuite.id, datasetId);
  };

  const commitSuiteDatasetAssignment = (suiteId: string, datasetId: string) => {
    setState((current) => {
      const outcome = assignEvaluationSuiteResource(current, { suiteId, datasetId });
      if (outcome.message) toast.warn(outcome.message);
      return outcome.state;
    });
  };

  const assignTargetGraph = (graphId: string) => {
    if (!selectedSuite || graphId === selectedSuite.targetGraphId) return;
    const hasTargetContracts =
      selectedSuite.inputBindings.length > 0 ||
      selectedSuite.assertions.length > 0 ||
      selectedSuite.evaluators.some((evaluator) =>
        evaluator.inputBindings?.some((binding) => binding.source.kind === 'target-output'),
      );
    if (hasTargetContracts) {
      setConfirmation({
        title: 'Change target graph?',
        description:
          'Changing the target graph clears target-input bindings, deterministic-check output selections, and evaluator bindings to target outputs.',
        confirmLabel: 'Change graph',
        onConfirm: () => commitTargetGraphAssignment(selectedSuite.id, graphId),
      });
      return;
    }
    commitTargetGraphAssignment(selectedSuite.id, graphId);
  };

  const commitTargetGraphAssignment = (suiteId: string, graphId: string) => {
    setState((current) => {
      const outcome = assignEvaluationSuiteResource(current, {
        suiteId,
        graphId: graphId as EvaluationSuite['targetGraphId'],
      });
      if (outcome.message) toast.warn(outcome.message);
      return outcome.state;
    });
  };

  const targetInputs =
    selectedSuite && referenceStatus?.targetGraphExists
      ? (project.graphs[selectedSuite.targetGraphId]?.nodes.filter((node) => node.type === 'graphInput') as
          | GraphInputNode[]
          | undefined) ?? []
      : [];
  const targetOutputs =
    selectedSuite && referenceStatus?.targetGraphExists
      ? getEvaluationTargetOutputs(project.graphs[selectedSuite.targetGraphId]?.nodes ?? [])
      : [];
  const hasQualityCriteria = selectedSuite ? hasAuthoritativeEvaluationCriteria(selectedSuite) : false;
  const isScoringSuite = selectedSuite ? getEvaluationSuiteMode(selectedSuite) === 'scoring' : false;
  const hasInvalidQualityChecks =
    !isScoringSuite &&
    (selectedSuite?.assertions.some((assertion) =>
      Boolean(
        getEvaluationAssertionAuthoringIssue(
          assertion,
          targetOutputs,
          suiteDataset?.fields.filter((field) => field.role === 'expected') ?? [],
        ),
      ),
    ) ??
      false);
  const expectedValueIssues =
    selectedSuite && suiteDataset ? getEvaluationExpectedValueAuthoringIssues(selectedSuite, suiteDataset) : [];
  const datasetValueTypeIssues = suiteDataset ? getEvaluationDatasetValueTypeAuthoringIssues(suiteDataset) : [];
  const datasetValueTypeIssueSet = new Set(datasetValueTypeIssues);
  const hasInvalidDatasetValues = datasetValueTypeIssues.length > 0;
  const hasInvalidExpectedValues = expectedValueIssues.some((issue) => !datasetValueTypeIssueSet.has(issue));
  const hasInvalidEvaluatorConfiguration =
    selectedSuite?.evaluators.some((evaluator) =>
      getEvaluationEvaluatorAuthoringIssue(evaluator, project, selectedSuite, suiteDataset),
    ) ?? false;
  const hasInvalidThresholdConfiguration =
    !isScoringSuite &&
    (selectedSuite?.thresholds?.some((threshold) => getEvaluationThresholdAuthoringIssue(threshold, selectedSuite)) ??
      false);
  const hasInvalidEvaluationConfiguration = hasInvalidEvaluatorConfiguration || hasInvalidThresholdConfiguration;
  const inputBindingIssues =
    selectedSuite && suiteDataset
      ? getEvaluationInputBindingAuthoringIssues(selectedSuite, suiteDataset, targetInputs)
      : [];
  const executionConfigurationIssues = selectedSuite
    ? getEvaluationExecutionConfigurationAuthoringIssues(selectedSuite, targetInputs)
    : [];
  const hasInvalidExecutionSetup = inputBindingIssues.length > 0 || executionConfigurationIssues.length > 0;
  const executionCount =
    (suiteDataset?.cases.filter((testCase) => testCase.enabled !== false).length ?? 0) *
    (selectedSuite?.configuration?.trialCount ?? 1);
  const targetExecutionLabel = `${executionCount} target execution${executionCount === 1 ? '' : 's'}`;
  const usesPromptDesignerDraft =
    selectedSuite !== undefined &&
    referenceStatus?.targetGraphExists === true &&
    resolvePromptDesignerEvaluationProject(
      state.promptDesignerProjectOverride,
      project.metadata.id,
      selectedSuite.targetGraphId,
    ) !== undefined;
  const suiteWideWarnings = selectedSuite
    ? getEvaluationSuiteWarnings({
        mode: isScoringSuite ? 'scoring' : 'pass-fail',
        hasQualityCriteria,
        projectAvailable,
        datasetExists: referenceStatus?.datasetExists === true,
        targetGraphExists: referenceStatus?.targetGraphExists === true,
        evaluatorGraphsExist: referenceStatus?.evaluatorGraphsExist === true,
        executionCount,
        hasInvalidDatasetDraft,
        hasInvalidDatasetValues,
        hasInvalidExecutionSetup,
        hasInvalidQualityChecks,
        hasInvalidExpectedValues,
        hasInvalidEvaluatorConfiguration,
        hasInvalidThresholdConfiguration,
        usesPromptDesignerDraft,
        hasDormantPassFailConfiguration:
          isScoringSuite && (selectedSuite.assertions.length > 0 || (selectedSuite.thresholds?.length ?? 0) > 0),
        anotherEvaluationRunning: state.runningSuiteId !== undefined && state.runningSuiteId !== selectedSuite.id,
      })
    : [];

  const benchmarkDisabled =
    !projectAvailable ||
    executionCount === 0 ||
    hasInvalidDatasetDraft ||
    hasInvalidDatasetValues ||
    hasInvalidExecutionSetup ||
    !referenceStatus?.datasetExists ||
    !referenceStatus?.targetGraphExists ||
    state.runningSuiteId !== undefined;
  const evaluationDisabled =
    benchmarkDisabled ||
    !hasQualityCriteria ||
    hasInvalidQualityChecks ||
    hasInvalidExpectedValues ||
    hasInvalidEvaluationConfiguration ||
    !referenceStatus?.evaluatorGraphsExist;
  const evaluationDisabledTitle = !projectAvailable
    ? "Open a project containing this suite's target graph and any evaluator graphs before running it."
    : !referenceStatus?.datasetExists
      ? 'Select an available evaluation dataset before running this suite.'
      : !referenceStatus?.targetGraphExists
        ? 'Select a target graph that exists in the open project before running this suite.'
        : executionCount === 0
          ? 'Enable or add at least one dataset case before running this suite.'
          : !hasQualityCriteria
            ? isScoringSuite
              ? 'Add an evaluator graph that returns result.score before running a scoring evaluation.'
              : 'Add a required quality check, evaluator graph, or threshold before running an evaluation.'
            : hasInvalidDatasetDraft
              ? 'Fix invalid dataset values before running this evaluation.'
              : hasInvalidDatasetValues
                ? 'Fix dataset values that do not match their declared field types before running.'
                : hasInvalidExecutionSetup
                  ? 'Fix target input bindings, missing case input values, and execution settings before running.'
                  : hasInvalidQualityChecks
                    ? 'Fix the highlighted deterministic quality checks before running this evaluation.'
                    : hasInvalidExpectedValues
                      ? isScoringSuite
                        ? 'Add missing required dataset values and fix values that do not match their declared field types.'
                        : 'Add the required expected values and fix values that do not match their quality checks.'
                      : !referenceStatus?.evaluatorGraphsExist
                        ? 'Repair or remove missing evaluator graphs before running this suite.'
                        : hasInvalidEvaluationConfiguration
                          ? hasInvalidEvaluatorConfiguration && hasInvalidThresholdConfiguration
                            ? 'Fix the highlighted evaluator graph and aggregate threshold settings before running this evaluation.'
                            : hasInvalidEvaluatorConfiguration
                              ? 'Fix the highlighted evaluator graph settings before running this evaluation.'
                              : 'Fix the highlighted aggregate threshold settings before running this evaluation.'
                          : state.runningSuiteId !== undefined
                            ? 'Another evaluation is already running for this project.'
                            : undefined;

  const {
    runsStatus,
    runsError,
    runDetailsLoading,
    runDetailsError,
    loadingHistoryPage,
    setRunDetailsRetry,
    loadMoreRunHistory,
    invalidateHistory,
    markHistoryReady,
  } = useEvaluationHistory({
    state,
    setState,
    projectId: project.metadata.id,
    projectAvailable,
    selectedSuiteId,
    runStore,
    suiteRuns,
    suiteCurrentRun,
    hasCachedRunHistory,
  });

  // An in-memory snapshot is authoritative while the runner is active and
  // remains useful for the terminal hand-off to durable history. Keep it
  // visible rather than replacing it with a loader (or a history-read error);
  // the failed read is still surfaced as a non-blocking warning.
  const runsHistoryPresentation = getEvaluationRunHistoryPresentation(
    runsStatus,
    runHistoryScope !== undefined,
    hasCachedRunHistory,
    suiteCurrentRun !== undefined,
  );
  const visibleRunsStatus = runsHistoryPresentation.status;
  const runHistoryRefreshError = runsHistoryPresentation.hasEvidence ? runsError : undefined;

  const updateRunScoreSort = useCallback(
    (scoreSort: EvaluationScoreSort) => {
      if (!runHistoryScopeKey) return;
      setState((current) =>
        current.runScoreSortByScope[runHistoryScopeKey] === scoreSort
          ? current
          : {
              ...current,
              runScoreSortByScope: { ...current.runScoreSortByScope, [runHistoryScopeKey]: scoreSort },
            },
      );
    },
    [runHistoryScopeKey, setState],
  );

  const updateExpandedTrials = useCallback(
    (runId: string | undefined, trialIds: readonly string[]) => {
      if (!runHistoryProjectId || !runHistorySuiteId) return;
      const scope: EvaluationRunHistoryScope = {
        projectId: runHistoryProjectId,
        suiteId: runHistorySuiteId,
      };
      const nextTrialIds = [...new Set(trialIds)];
      setState((current) => {
        if (!runId || nextTrialIds.length === 0) {
          return current.runTrialExpansion === undefined ? current : { ...current, runTrialExpansion: undefined };
        }
        const currentExpansion = current.runTrialExpansion;
        if (
          currentExpansion?.scope.projectId === scope.projectId &&
          currentExpansion.scope.suiteId === scope.suiteId &&
          currentExpansion.runId === runId &&
          currentExpansion.trialIds.length === nextTrialIds.length &&
          currentExpansion.trialIds.every((trialId, index) => trialId === nextTrialIds[index])
        ) {
          return current;
        }
        return {
          ...current,
          runTrialExpansion: { scope, runId, trialIds: nextTrialIds },
        };
      });
    },
    [runHistoryProjectId, runHistorySuiteId, setState],
  );

  const selectRun = useCallback(
    (runId: string) =>
      setState((current) => ({
        ...current,
        selectedRunId: runId,
        // A trial card belongs to one run. Match the previous in-component
        // behaviour and never carry it to the newly selected history entry.
        runTrialExpansion: undefined,
      })),
    [setState],
  );

  const persistRunScrollPosition = useCallback(() => {
    if (view !== 'runs' || !runHistoryScopeKey) return;
    const scrollTop = Math.max(0, runScrollTopRef.current);
    setState((current) =>
      current.runScrollTopByScope[runHistoryScopeKey] === scrollTop
        ? current
        : {
            ...current,
            runScrollTopByScope: { ...current.runScrollTopByScope, [runHistoryScopeKey]: scrollTop },
          },
    );
  }, [runHistoryScopeKey, setState, view]);

  useEffect(() => {
    return () => persistRunScrollPosition();
  }, [persistRunScrollPosition]);

  useLayoutEffect(() => {
    if (view !== 'runs' || !runHistoryScopeKey || !hasCachedRunHistory) {
      restoredRunScrollScopeRef.current = undefined;
      return;
    }
    if (restoredRunScrollScopeRef.current === runHistoryScopeKey) return;

    const scrollTop = state.runScrollTopByScope[runHistoryScopeKey] ?? 0;
    if (evaluationMainRef.current) evaluationMainRef.current.scrollTop = scrollTop;
    runScrollTopRef.current = scrollTop;
    restoredRunScrollScopeRef.current = runHistoryScopeKey;
  }, [hasCachedRunHistory, runHistoryScopeKey, state.runScrollTopByScope, view]);

  useEffect(() => {
    if (view === 'dataset' && !selectedDataset) setView('definition');
    if (view === 'compare' && !compareAvailable) setView('runs');
  }, [compareAvailable, selectedDataset, setView, view]);

  useEffect(() => {
    setConfirmation(undefined);
  }, [project.metadata.id, selectedSuiteId]);

  useEffect(() => {
    if (!state.requestedView) return;
    const requestedView = state.requestedView;
    const allowed =
      (requestedView === 'dataset' && selectedDataset != null) ||
      (requestedView !== 'dataset' && selectedSuite != null && (requestedView !== 'compare' || compareAvailable));
    setView(allowed ? requestedView : 'definition');
    setState((current) => ({ ...current, requestedView: undefined }));
  }, [compareAvailable, selectedDataset, selectedSuite, setState, setView, state.requestedView]);

  const runSelectedEvaluation = (purpose: EvaluationRunPurpose) => {
    if (!selectedSuite || !projectAvailable) {
      toast.info("Open a project containing this suite's target graph and any evaluator graphs before running it.");
      return;
    }
    const promptDesignerCandidate = resolvePromptDesignerEvaluationProject(
      state.promptDesignerProjectOverride,
      project.metadata.id,
      selectedSuite.targetGraphId,
    );
    void tryRunEvaluation({ suiteId: selectedSuite.id, purpose, projectOverride: promptDesignerCandidate });
  };

  const startEvaluation = (purpose: EvaluationRunPurpose) => {
    if (
      !selectedSuite ||
      !projectAvailable ||
      executionCount === 0 ||
      hasInvalidDatasetDraft ||
      hasInvalidDatasetValues ||
      hasInvalidExecutionSetup ||
      (purpose === 'evaluation' &&
        (!hasQualityCriteria ||
          hasInvalidQualityChecks ||
          hasInvalidExpectedValues ||
          hasInvalidEvaluationConfiguration ||
          !referenceStatus?.evaluatorGraphsExist)) ||
      !referenceStatus?.datasetExists ||
      !referenceStatus.targetGraphExists
    ) {
      return;
    }
    if (state.runningSuiteId !== undefined) return;
    const projectedExecutionsForPurpose =
      executionCount * (1 + (purpose === 'evaluation' ? selectedSuite.evaluators.length : 0));
    if (projectedExecutionsForPurpose >= 100) {
      setConfirmation({
        title: 'Run a large evaluation?',
        description: `This ${purpose === 'evaluation' ? 'evaluation' : 'execution benchmark'} can start up to ${projectedExecutionsForPurpose} graph executions. ${purpose === 'evaluation' ? 'Target and evaluator graph costs' : 'Target graph costs'} depend on their configured providers.`,
        confirmLabel: purpose === 'evaluation' ? 'Run evaluation' : 'Run execution benchmark',
        onConfirm: () => runSelectedEvaluation(purpose),
      });
      return;
    }
    runSelectedEvaluation(purpose);
  };

  const requestRetryInterruptedTrials = (run: EvaluationRun, jobIds: readonly string[]) => {
    if (!projectAvailable) {
      toast.info('Open this Evaluation project before retrying hosted trials.');
      return;
    }
    const uniqueJobIds = [...new Set(jobIds)];
    if (uniqueJobIds.length === 0 || retryingHostedRunId === run.id) return;
    const trialLabel = `${uniqueJobIds.length} interrupted trial${uniqueJobIds.length === 1 ? '' : 's'}`;
    setConfirmation({
      title: `Retry ${trialLabel}?`,
      description:
        'A worker may have started these trials before it was interrupted. Retrying can repeat model calls, tool calls, external side effects, and cost. Only retry work that is safe to run again.',
      confirmLabel: `Retry ${trialLabel}`,
      onConfirm: () => {
        void (async () => {
          setRetryingHostedRunId(run.id);
          try {
            await retryInterruptedEvaluation({ runId: run.id, jobIds: uniqueJobIds });
          } catch (error) {
            toast.error(
              `Could not retry interrupted trials: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            setRetryingHostedRunId(undefined);
          }
        })();
      },
    });
  };

  const openRecording = async (recordingId: string) => {
    try {
      const artifact = await runStore.getRecording({ projectId: project.metadata.id, recordingId });
      if (!isCommandScopeCurrent()) return;
      if (!artifact) {
        toast.info(
          'This evaluation recording is no longer retained. Run the suite again to create a new replay artifact.',
        );
        return;
      }
      if (artifact.projectId !== project.metadata.id || artifact.reference.id !== recordingId)
        throw new Error('Evaluation recording does not match the requested project and recording.');
      if (
        loadSerializedRecording({
          serialized: artifact.serialized,
          path: `Evaluation recording · ${artifact.reference.id}`,
          projectId: artifact.projectId,
        })
      ) {
        setOpenOverlay(undefined);
      }
    } catch (error) {
      toast.error(
        `Could not retrieve the evaluation recording: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const commandScopeRevision = commandScope.current.revision;
  const isCommandScopeCurrent = () =>
    commandScope.current.mounted && commandScope.current.revision === commandScopeRevision;
  const { renameEvaluationRun, updateEvaluationRunRecordingRetention, deleteEvaluationRun, promoteBaseline } =
    createEvaluationRunCommands({
      state,
      setState,
      projectId: project.metadata.id,
      runStore,
      selectedSuite,
      comparableRun,
      invalidateHistory,
      markHistoryReady,
      isCurrent: isCommandScopeCurrent,
      onNotice: ({ kind, message, level }) => {
        if (!isCommandScopeCurrent()) return;
        if (kind === 'failed') toast.error(message);
        else if (kind === 'success') toast.success(message);
        else if (level === 'info') toast.info(message);
        else toast.warn(message);
      },
    });

  const requestDeleteEvaluationRun = (run: EvaluationRun) => {
    const isLiveRun =
      state.currentRun?.id === run.id &&
      (state.currentRun.executionStatus === 'queued' || state.currentRun.executionStatus === 'running');
    if (isLiveRun) {
      toast.warn('A running evaluation cannot be deleted. Cancel it or wait for it to finish first.');
      return;
    }
    setConfirmation({
      appearance: 'danger',
      title: 'Delete evaluation run?',
      description: `Delete "${run.name?.trim() || 'Unnamed'}"? This permanently removes its run history and every replay recording for the run, including manually kept and baseline recordings. A compact baseline snapshot remains available for comparison, but its replay recordings will be gone.`,
      confirmLabel: 'Delete run',
      onConfirm: () => void deleteEvaluationRun(run),
    });
  };

  const exportSelectedSuite = () => {
    if (!selectedSuite || !suiteDataset) {
      toast.warn('A suite needs an available evaluation dataset before it can be exported.');
      return;
    }
    void transferCommands.exportSuite(selectedSuite, suiteDataset);
  };

  const updateDatasetResource = (dataset: EvaluationDataset) =>
    setState((current) => ({
      ...current,
      datasets: current.datasets.map((item) => (item.id === dataset.id ? dataset : item)),
    }));

  const exportSelectedDatasetJson = () => {
    if (selectedDataset) void transferCommands.exportDataset(selectedDataset, 'json');
  };
  const exportSelectedDatasetCsv = () => {
    if (selectedDataset) void transferCommands.exportDataset(selectedDataset, 'csv');
  };
  const importSelectedDataset = () => {
    if (selectedDataset) void transferCommands.replaceDataset(selectedDataset);
  };

  return (
    <div css={styles}>
      <EvaluationSuiteSidebar
        canCreateDataset
        canCreateSuite={projectAvailable && graphOptions.length > 0}
        datasets={localDatasets}
        getDatasetUsage={(dataset) => {
          const usage = state.data.suites.filter((suite) => suite.datasetId === dataset.id).length;
          return `${usage} evaluation suite${usage === 1 ? '' : 's'}`;
        }}
        selectedSuiteId={showingDataset ? undefined : selectedSuite?.id}
        selectedDatasetId={showingDataset ? selectedDataset?.id : undefined}
        suites={state.data.suites}
        getGraphName={(suite) =>
          projectAvailable
            ? project.graphs[suite.targetGraphId]?.metadata?.name ?? 'Missing target graph'
            : 'Open a project to resolve graph'
        }
        getReferenceStatus={(suite) => getEvaluationSuiteReferenceStatus(suite, project, state.datasets)}
        onCreateDataset={createDatasetResource}
        onCreateSuite={() => setCreateSuiteOpen(true)}
        onDeleteDataset={requestDeleteDataset}
        onDeleteSuite={requestDeleteSuite}
        onImportDataset={importDatasetResource}
        onImportSuite={importSuiteResource}
        onSelectDataset={selectDataset}
        onSelectSuite={selectSuite}
        runningSuiteId={state.runningSuiteId}
      />
      <main
        className="evaluation-main"
        ref={evaluationMainRef}
        onScroll={(event) => {
          if (view === 'runs' && runHistoryScopeKey) runScrollTopRef.current = event.currentTarget.scrollTop;
        }}
      >
        {showingDataset ? (
          <>
            <header className="evaluation-suite-header evaluation-dataset-header">
              <div className="evaluation-suite-title-row">
                <ResourceTitle
                  editing={renamingDatasetId === selectedDataset.id}
                  fallback="Untitled evaluation dataset"
                  label="evaluation dataset"
                  value={selectedDataset.name}
                  onStartEditing={() => setRenamingDatasetId(selectedDataset.id)}
                  onFinishEditing={() => setRenamingDatasetId(undefined)}
                  onCommit={(name) => updateDatasetResource({ ...selectedDataset, name })}
                />
                <div className="spacer" />
                <div className="evaluation-run-actions evaluation-dataset-transfer-actions">
                  <Button
                    appearance="subtle"
                    className="evaluation-secondary-action"
                    onClick={exportSelectedDatasetJson}
                  >
                    Export JSON
                  </Button>
                  <Button
                    appearance="subtle"
                    className="evaluation-secondary-action"
                    onClick={exportSelectedDatasetCsv}
                  >
                    Export CSV
                  </Button>
                  <Button appearance="subtle" className="evaluation-secondary-action" onClick={importSelectedDataset}>
                    Import (replace)
                  </Button>
                </div>
              </div>
              <p className="evaluation-suite-subtitle">
                Evaluation dataset ·{' '}
                <button
                  aria-controls="evaluation-dataset-usage-disclosure"
                  aria-expanded={datasetUsageExpanded}
                  className="evaluation-dataset-usage-toggle"
                  type="button"
                  onClick={() => setDatasetUsageExpanded((expanded) => !expanded)}
                >
                  Used by {selectedDatasetSuites.length} evaluation suite
                  {selectedDatasetSuites.length === 1 ? '' : 's'}
                </button>
              </p>
              {datasetUsageExpanded ? (
                <div className="evaluation-dataset-usage-disclosure" id="evaluation-dataset-usage-disclosure">
                  <strong>Used by evaluation suites</strong>
                  {selectedDatasetSuites.length === 0 ? (
                    <span>This dataset is not assigned to a suite yet.</span>
                  ) : (
                    <div>
                      {selectedDatasetSuites.map((suite) => (
                        <Button
                          appearance="subtle"
                          className="evaluation-secondary-action"
                          key={suite.id}
                          onClick={() => selectSuite(suite.id)}
                        >
                          {suite.name || 'Untitled evaluation suite'}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </header>
            <div className="evaluation-panel">
              <Dataset
                dataset={selectedDataset}
                onAddCase={() => addCase(selectedDataset)}
                onInvalidDraftChange={setHasInvalidDatasetDraft}
                onRemoveField={(fieldId) => requestRemoveDatasetField(selectedDataset.id, fieldId)}
                onUpdate={updateDatasetResource}
              />
            </div>
          </>
        ) : !selectedSuite ? (
          <div className="workspace-empty">
            <div className="workspace-empty-content">
              <h1>
                {state.data.suites.length === 0 && localDatasets.length === 0
                  ? 'Create an evaluation suite or dataset'
                  : 'Select an evaluation suite or dataset'}
              </h1>
              <p>
                {state.data.suites.length === 0 && localDatasets.length === 0
                  ? !projectAvailable
                    ? 'Create or import reusable datasets here, or import a suite. Open a project when you are ready to create, bind, and run a suite.'
                    : graphOptions.length === 0
                      ? 'Create an evaluation dataset now, then create a graph before adding a suite that runs it.'
                      : 'Create a suite for a graph, or create a reusable dataset first.'
                  : 'Suites run graphs against datasets. Select either resource from the left to edit it.'}
              </p>
              <div className="workspace-empty-actions">
                {projectAvailable && graphOptions.length > 0 ? (
                  <Button appearance="primary" onClick={() => setCreateSuiteOpen(true)}>
                    Create evaluation suite
                  </Button>
                ) : null}
                <Button onClick={createDatasetResource}>Create evaluation dataset</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <EvaluationSuiteRunStatus
              warnings={suiteWideWarnings}
              targetExecutionLabel={targetExecutionLabel}
              isRunning={state.runningSuiteId === selectedSuite.id}
              showBenchmark={!hasQualityCriteria}
              benchmarkDisabled={benchmarkDisabled}
              evaluationDisabled={evaluationDisabled}
              exportDisabled={!suiteDataset}
              benchmarkTitle={`Runs ${targetExecutionLabel} and measures execution without producing a quality result.`}
              evaluationTitle={evaluationDisabledTitle}
              exportTitle={
                suiteDataset ? 'Export this suite and its evaluation dataset' : 'Repair the dataset reference first'
              }
              onExport={exportSelectedSuite}
              onRunBenchmark={() => startEvaluation('execution-benchmark')}
              onRunEvaluation={() => startEvaluation('evaluation')}
              onCancel={abortEvaluation}
            />
            <header className="evaluation-suite-header evaluation-suite-header-with-sticky-status">
              <div className="evaluation-suite-title-row">
                <ResourceTitle
                  editing={renamingSuiteId === selectedSuite.id}
                  fallback="Untitled evaluation suite"
                  label="evaluation suite"
                  value={selectedSuite.name}
                  onStartEditing={() => setRenamingSuiteId(selectedSuite.id)}
                  onFinishEditing={() => setRenamingSuiteId(undefined)}
                  onCommit={(name) => updateSuite((suite) => ({ ...suite, name }))}
                />
                <div className="spacer" />
                <Button
                  appearance="subtle"
                  className="evaluation-secondary-action evaluation-suite-header-export"
                  isDisabled={!suiteDataset}
                  title={
                    suiteDataset ? 'Export this suite and its evaluation dataset' : 'Repair the dataset reference first'
                  }
                  onClick={exportSelectedSuite}
                >
                  Export suite + dataset
                </Button>
              </div>
              <p className="evaluation-suite-subtitle">
                {referenceStatus?.targetGraphExists
                  ? project.graphs[selectedSuite.targetGraphId]?.metadata?.name ?? selectedSuite.targetGraphId
                  : 'Missing target graph'}
                {' · '}
                {referenceStatus?.datasetExists ? suiteDataset?.name : 'Missing evaluation dataset'}
                {!referenceStatus?.evaluatorGraphsExist ? ' · Missing evaluator graph' : ''}
              </p>
              <EvaluationSectionTabs
                activeView={view === 'dataset' ? 'definition' : view}
                compareAvailable={compareAvailable}
                onSelect={setView}
              />
            </header>
            <div
              className="evaluation-panel"
              role="tabpanel"
              id={`evaluation-panel-${view}`}
              aria-labelledby={`evaluation-tab-${view}`}
            >
              {view === 'definition' && (
                <Definition
                  suite={selectedSuite}
                  project={project}
                  dataset={suiteDataset}
                  datasets={localDatasets}
                  graphOptions={graphOptions}
                  targetInputs={targetInputs}
                  targetOutputs={targetOutputs}
                  targetGraphExists={referenceStatus?.targetGraphExists === true}
                  selectedDefinitionTab={suitePresentation.definitionView}
                  showAdditionalExecutionSettings={suitePresentation.additionalExecutionSettingsExpanded}
                  onUpdate={updateSuite}
                  onAssignDataset={assignSuiteDataset}
                  onAssignTargetGraph={assignTargetGraph}
                  onSelectedDefinitionTabChange={(definitionView) =>
                    updateSelectedSuitePresentation({ definitionView })
                  }
                  onShowAdditionalExecutionSettingsChange={(additionalExecutionSettingsExpanded) =>
                    updateSelectedSuitePresentation({ additionalExecutionSettingsExpanded })
                  }
                />
              )}
              {view === 'runs' && (
                <Runs
                  dataset={suiteDataset}
                  runs={suiteRuns}
                  historyEntries={suiteHistoryEntries}
                  detailsLoading={
                    runDetailsLoading ||
                    (!!state.selectedRunId &&
                      !suiteRuns.some((run) => run.id === state.selectedRunId) &&
                      suiteCurrentRun?.id !== state.selectedRunId)
                  }
                  detailsError={runDetailsError}
                  onRetryDetails={() => setRunDetailsRetry((value) => value + 1)}
                  hasMoreHistory={state.runHistoryNextCursor !== undefined}
                  loadingHistoryPage={loadingHistoryPage}
                  onLoadMoreHistory={() => void loadMoreRunHistory()}
                  currentRun={suiteCurrentRun}
                  selectedRunId={state.selectedRunId}
                  scoreSort={runScoreSort}
                  status={visibleRunsStatus}
                  error={visibleRunsStatus === 'error' ? runsError : undefined}
                  refreshError={runHistoryRefreshError}
                  expandedTrialExpansion={visibleRunTrialExpansion}
                  retryingHostedRunId={retryingHostedRunId}
                  onRetryInterrupted={requestRetryInterruptedTrials}
                  onSelect={selectRun}
                  onScoreSortChange={updateRunScoreSort}
                  onExpandedTrialsChange={updateExpandedTrials}
                  onRename={(runId, name) => void renameEvaluationRun(runId, name)}
                  onDelete={requestDeleteEvaluationRun}
                  onKeepRecordings={(run) => void updateEvaluationRunRecordingRetention(run, 'keep')}
                  onReleaseRecordings={(run) => void updateEvaluationRunRecordingRetention(run, 'release')}
                  onOpenRecording={(recordingId) => void openRecording(recordingId)}
                />
              )}
              {view === 'compare' && (
                <Compare
                  suite={selectedSuite}
                  runs={suiteRuns}
                  run={comparableRun}
                  baseline={suiteBaseline}
                  onPromote={() => void promoteBaseline()}
                />
              )}
            </div>
          </>
        )}
      </main>
      <CreateEvaluationSuiteModal
        datasets={localDatasets}
        graphOptions={graphOptions}
        initialGraphId={graph.metadata?.id}
        open={createSuiteOpen}
        onClose={() => setCreateSuiteOpen(false)}
        onCreate={createSuiteFromDialog}
      />
      <EvaluationConfirmModal confirmation={confirmation} onClose={() => setConfirmation(undefined)} />
    </div>
  );
};
