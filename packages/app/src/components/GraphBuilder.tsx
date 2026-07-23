import { type FC, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { NodeCanvas } from './NodeCanvas.js';
import { useAtomValue, useAtom, useSetAtom } from 'jotai';
import { connectionsState, isReadOnlyGraphState, nodesByIdState, nodesState } from '../state/graph.js';
import { editingNodeState, selectedNodesState } from '../state/graphBuilder.js';
import { NodeEditorRenderer } from './NodeEditor.js';
import styled from '@emotion/styled';
import { useStableCallback } from '../hooks/useStableCallback.js';
import {
  type ArrayDataValue,
  type ChartNode,
  getNodePrefabInstancePrefabId,
  isNodePrefabInstanceNode,
  type StringDataValue,
} from '@valerypopoff/rivet2-core';
import { type ProcessQuestions, userInputModalQuestionsState } from '../state/userInput.js';
import { UserInputModal } from './UserInputModal.js';
import Button from '@atlaskit/button';
import { isNotNull } from '../utils/genericUtilFunctions.js';
import { ErrorBoundary } from 'react-error-boundary';
import { loadedRecordingState } from '../state/execution.js';
import { useGraphHistoryNavigation } from '../hooks/useGraphHistoryNavigation';
import { entries } from '../utils/typeSafety';
import { useGraphBuilderContextMenuHandler } from '../hooks/useGraphBuilderContextMenuHandler';
import { NavigationBar } from './NavigationBar';
import { projectState } from '../state/savedGraphs';
import { useDatasets } from '../hooks/useDatasets';
import { overlayOpenState } from '../state/ui';
import { GraphExecutionSelectorBar } from './GraphExecutionSelectorBar';
import { HistoricalGraphNotice } from './HistoricalGraphNotice';
import { NodeChangesModalRenderer } from './NodeChangesModal';
import { ProjectComparisonNodeChangesModalRenderer } from './ProjectComparisonNodeChangesModal.js';
import { AiGraphCreatorInput } from './AiGraphCreatorInput';
import { AiGraphCreatorToggle } from './AiGraphCreatorToggle';
import { useReloadProjectReferences } from '../hooks/useReloadProjectReferences';
import { submitUserInputAnswers } from '../state/actions/userInputActions';
import { useSyncCurrentProjectEditorState } from '../hooks/useSyncCurrentProjectEditorState.js';
import { toggleNodeSelection } from '../domain/graphEditing/nodeSelection.js';
import { useSyncProjectPluginsFromGraphUsage } from '../hooks/useSyncProjectPluginsFromGraphUsage.js';
import { warmCodeEditor } from './LazyComponents.js';
import {
  activeProjectComparisonState,
  projectCompareReferenceState,
  resolveProjectCompareSideLabels,
  selectedGraphProjectComparisonState,
} from '../state/projectComparison.js';
import {
  formatProjectComparisonCounts,
  formatProjectComparisonCurrentGraphCounts,
  getGraphProjectComparisonCounts,
  getOverallProjectComparisonCounts,
  getProjectComparisonReferenceFileName,
} from '../utils/projectComparisonSummary.js';
import { useOpenNodeLibrary } from '../hooks/useOpenNodeLibrary.js';

const Container = styled.div`
  position: relative;

  .user-input-modal-open {
    position: absolute;
    top: calc(62px + var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
    right: 16px;
    z-index: 100;
  }

  .recording-border {
    position: absolute;
    top: calc(var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 500;
    box-shadow: inset 0 0 2px 3px var(--warning-dark);
  }

  .read-only-border {
    position: absolute;
    top: calc(var(--project-selector-height) + var(--data-bus-full-row-height, 0px));
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 500;
    box-shadow: inset 0 0 2px 3px var(--grey-light);
  }

  .project-compare-notice {
    position: absolute;
    top: calc(var(--project-selector-height) + var(--data-bus-full-row-height, 0px) + 12px);
    left: 50%;
    z-index: 450;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    max-width: min(720px, calc(100vw - 48px));
    padding: 8px 10px 8px 14px;
    border: 1px solid color-mix(in srgb, var(--primary) 45%, transparent);
    border-radius: 12px;
    corner-shape: squircle;
    background: color-mix(in srgb, var(--modal-surface-bg) 96%, var(--primary) 4%);
    box-shadow: var(--popup-shadow);
    color: var(--foreground);
    font-size: var(--ui-font-size-sm);
    line-height: 1.35;
    transform: translateX(-50%);
  }

  .project-compare-notice strong {
    color: var(--primary-text);
  }

  .project-compare-notice-text {
    min-width: 0;
  }

  .project-compare-notice-text > div + div {
    margin-top: 2px;
  }
`;

export const GraphBuilder: FC = () => {
  const [nodes, setNodes] = useAtom(nodesState);
  const [connections, setConnections] = useAtom(connectionsState);
  const [selectedNodeIds, setSelectedNodeIds] = useAtom(selectedNodesState);
  const setEditingNodeId = useSetAtom(editingNodeState);
  const loadedRecording = useAtomValue(loadedRecordingState);
  const project = useAtomValue(projectState);
  const activeComparison = useAtomValue(activeProjectComparisonState);
  const selectedGraphComparison = useAtomValue(selectedGraphProjectComparisonState);
  const setProjectCompareReference = useSetAtom(projectCompareReferenceState);

  useReloadProjectReferences();
  useSyncCurrentProjectEditorState();

  useDatasets(project.metadata.id);

  const historyNav = useGraphHistoryNavigation();
  useSyncProjectPluginsFromGraphUsage();

  const nodesChanged = useStableCallback((newNodes: ChartNode[]) => {
    setNodes?.(newNodes);
  });

  const nodesById = useAtomValue(nodesByIdState);
  const contextMenuHandler = useGraphBuilderContextMenuHandler();
  const openNodeLibrary = useOpenNodeLibrary();

  const nodeSelected = useStableCallback((node: ChartNode, multi: boolean) => {
    if (!multi) {
      return; // Can only "select" a node if you're holding shift, for now
    }
    setSelectedNodeIds((nodeIds) => toggleNodeSelection(nodeIds, node.id));
  });

  const nodeStartEditing = useStableCallback((node: ChartNode) => {
    const prefabId = getNodePrefabInstancePrefabId(node);
    const sourceNode = prefabId ? project.nodePrefabs?.[prefabId]?.sourceNode : undefined;

    if (isNodePrefabInstanceNode(node)) {
      openNodeLibrary({
        editingPrefabId: prefabId,
        selectedNodeIds: sourceNode ? [sourceNode.id] : [],
      });
      return;
    }

    warmCodeEditor();
    setEditingNodeId(node.id);
  });

  const allCurrentQuestions = useAtomValue(userInputModalQuestionsState);
  const firstNodeQuestions = useMemo(() => entries(allCurrentQuestions)[0], [allCurrentQuestions]);

  const [isUserInputModalOpen, setUserInputModalOpen] = useState(false);

  const handleCloseUserInputModal = () => {
    setUserInputModalOpen(false);
  };

  const handleOpenUserInputModal = () => {
    setUserInputModalOpen(true);
  };

  const handleSubmitUserInputModal = (answers: ArrayDataValue<StringDataValue>) => {
    setUserInputModalOpen(false);
    submitUserInputAnswers(firstNodeQuestions![0], answers);
  };

  useEffect(() => {
    if (firstNodeQuestions && firstNodeQuestions.length > 0) {
      setUserInputModalOpen(true);
    }
  }, [firstNodeQuestions]);

  const containerMouseDown = useStableCallback((e: MouseEvent<HTMLDivElement>) => {
    if (e.buttons === 8) {
      e.preventDefault();
      // Mouse Back
      historyNav.navigateBack();
    } else if (e.buttons === 16) {
      e.preventDefault();
      // Mouse Forward
      historyNav.navigateForward();
    }
  });

  const [questionsNodeId, questions] = firstNodeQuestions ? firstNodeQuestions : [undefined, [] as ProcessQuestions[]];
  const lastQuestions = questions.at(-1)?.questions ?? [];

  const selectedNodes = useMemo(
    () => selectedNodeIds.map((nodeId) => nodesById[nodeId]).filter(isNotNull),
    [selectedNodeIds, nodesById],
  );
  const activeComparisonLabels = resolveProjectCompareSideLabels(activeComparison?.labels);

  const overlay = useAtomValue(overlayOpenState);
  const isReadOnly = useAtomValue(isReadOnlyGraphState);

  return (
    <Container onMouseDown={containerMouseDown}>
      <ErrorBoundary fallback={<div>Failed to render GraphBuilder</div>}>
        <NodeCanvas
          nodes={nodes}
          connections={connections}
          onNodesChanged={nodesChanged}
          onConnectionsChanged={setConnections}
          onNodeSelected={nodeSelected}
          selectedNodes={selectedNodes}
          onNodeStartEditing={nodeStartEditing}
          onContextMenuItemSelected={contextMenuHandler}
        />
        {loadedRecording && <div className="recording-border" />}
        {isReadOnly && <div className="read-only-border" />}
        {overlay === undefined && <NodeEditorRenderer />}
        {firstNodeQuestions && firstNodeQuestions.length > 0 && (
          <Button onClick={handleOpenUserInputModal} className="user-input-modal-open" appearance="primary">
            User Input Needed
          </Button>
        )}
        {overlay === undefined && <NavigationBar />}
        {activeComparison && (
          <div className="project-compare-notice">
            <div className="project-compare-notice-text">
              <div>
                Compare mode: {activeComparisonLabels.currentLabel} against {activeComparisonLabels.referenceLabel}{' '}
                <strong>
                  {getProjectComparisonReferenceFileName(
                    activeComparison.referencePath,
                    activeComparison.referenceProject.metadata.title,
                  )}
                </strong>
              </div>
              <div>
                - Overall difference:{' '}
                <strong>
                  {formatProjectComparisonCounts(getOverallProjectComparisonCounts(activeComparison.comparison))}
                </strong>
              </div>
              <div>
                - Current opened graph difference:{' '}
                <strong>
                  {formatProjectComparisonCurrentGraphCounts(getGraphProjectComparisonCounts(selectedGraphComparison))}
                </strong>
              </div>
            </div>
            <Button spacing="compact" onClick={() => setProjectCompareReference(undefined)}>
              Exit
            </Button>
          </div>
        )}
        <GraphExecutionSelectorBar />
        <HistoricalGraphNotice />
        <UserInputModal
          open={isUserInputModalOpen}
          questions={lastQuestions}
          questionsNodeId={questionsNodeId}
          onSubmit={handleSubmitUserInputModal}
          onClose={handleCloseUserInputModal}
        />
        <NodeChangesModalRenderer />
        <ProjectComparisonNodeChangesModalRenderer />
        <AiGraphCreatorInput />
        <AiGraphCreatorToggle />
      </ErrorBoundary>
    </Container>
  );
};
