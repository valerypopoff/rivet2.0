import type { ChartNode, LLMChatV2Node, ProcessId } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import EyeIcon from 'majesticons/line/eye-line.svg?react';
import ExpandIcon from 'majesticons/line/maximize-line.svg?react';
import FlaskIcon from 'majesticons/line/flask-line.svg?react';
import type { FC, MouseEvent } from 'react';
import { useMemo, useState } from 'react';
import ExpandDownStopIcon from '../../assets/icons/expand-down-stop.svg?react';
import SnowflakeIcon from '../../assets/icons/snowflake-icon.svg?react';
import { useNodeIO } from '../../hooks/useGetNodeIO.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { useUnknownNodeComponentDescriptorFor } from '../../hooks/useNodeTypes.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { promptDesignerAttachedChatNodeState } from '../../state/promptDesigner.js';
import {
  type NodeRunDataWithRefs,
  type ProcessDataForNode,
  getLLMChatOutputHistorySelectionKey,
  lastRunDataState,
  resolvedGraphSelectionState,
  selectedLLMChatOutputPageState,
  selectedProcessPageState,
} from '../../state/dataFlow.js';
import { showNodeRunDurationsState } from '../../state/settings.js';
import {
  filterProcessDataForSelection,
  getSelectedGraphRunId,
  getSelectedProcessPageIndex,
} from '../../state/selectors/executionSelectors.js';
import { overlayOpenState } from '../../state/ui.js';
import { Tooltip } from '../Tooltip.js';
import { AgentResponseInspector } from '../agentTrace/AgentResponseInspector.js';
import { buildLlmInvocationTrace } from '../agentTrace/agentTraceViewModel.js';
import { CodeNodeErrorOutput } from '../nodes/CodeNode.js';
import {
  getNodeOutputContentKey,
  NodeOutputContentFade,
  useOutputDataWithReplacementGrace,
} from './NodeOutputContentState.js';
import { copyOutputValue } from './nodeOutputCopyActions.js';
import { NodeOutputPager } from './NodeOutputPager.js';
import { LLMChatOutputHistoryPager } from './LLMChatOutputHistoryPager.js';
import { LLMChatSplitOutputHistory } from './LLMChatSplitOutputHistory.js';
import { resolveNodeOutputPreviewMode } from './nodeOutputPreviewMode.js';
import {
  createNodeOutputContentViewModel,
  getNodeOutputCopySource,
  getSelectedNodeOutputProcess,
} from './nodeOutputViewModel.js';
import {
  getLLMChatSplitOutputHistoryPresentationData,
  getSelectedLLMChatOutputHistoryData,
  shouldShowLLMChatOutputHistoryPager,
} from '../../utils/llmChatOutputHistory.js';
import {
  NodeRunDurationMeta,
  NodeRunDurationSummaryMeta,
  shouldShowNodeRunDurationMeta,
  shouldShowNodeRunDurationSummary,
} from './NodeRunDurationMeta.js';
import { nodeRunDataHasVisibleOutput } from './nodeOutputVisibility.js';
import { renderNodeOutputBody } from './renderNodeOutputBody.js';

export const NodeInlineOutput: FC<{
  node: ChartNode;
  isFrozen: boolean;
  isOutputExpanded: boolean;
  isHovered: boolean;
  onToggleExpandedOutput: () => void;
  onOpenFullscreenModal?: () => void;
}> = ({ node, isFrozen, isOutputExpanded, isHovered, onToggleExpandedOutput, onOpenFullscreenModal }) => {
  const dataRefs = useDataRefs();
  const output = useAtomValue(lastRunDataState(node.id));
  const selectedPage = useAtomValue(selectedProcessPageState(node.id));
  const showNodeRunDurations = useAtomValue(showNodeRunDurationsState);
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
  const filteredOutput = useMemo(
    () => filterProcessDataForSelection({ ...graphSelectionOptions, processData: output }),
    [graphSelectionOptions, output],
  );
  const selectedGraphRunScopeKey = getSelectedGraphRunId(
    graphSelectionOptions.graphRuns,
    graphSelectionOptions.selectedGraphRun,
  );
  const visibleOutput = useOutputDataWithReplacementGrace(node.type, filteredOutput, selectedPage, dataRefs, {
    replacementScopeKey: selectedGraphRunScopeKey,
    showNodeRunDuration: showNodeRunDurations,
  });

  if (!visibleOutput?.length) {
    return null;
  }

  if (visibleOutput.length === 1) {
    const firstOutput = visibleOutput[0];
    if (!firstOutput) {
      return null;
    }

    return (
      <div className="node-output">
        <NodeOutputSingleProcess
          node={node}
          processData={firstOutput}
          data={firstOutput.data}
          isFrozen={isFrozen}
          isOutputExpanded={isOutputExpanded}
          isHovered={isHovered}
          processId={firstOutput.processId}
          showNodeRunDuration={showNodeRunDurations}
          onToggleExpandedOutput={onToggleExpandedOutput}
          onOpenFullscreenModal={onOpenFullscreenModal}
        />
      </div>
    );
  } else {
    return (
      <div className="node-output multi">
        <NodeOutputMultiProcess
          node={node}
          data={visibleOutput}
          isFrozen={isFrozen}
          isOutputExpanded={isOutputExpanded}
          isHovered={isHovered}
          showNodeRunDuration={showNodeRunDurations}
          onToggleExpandedOutput={onToggleExpandedOutput}
          onOpenFullscreenModal={onOpenFullscreenModal}
        />
      </div>
    );
  }
};

const NodeOutputSingleProcess: FC<{
  node: ChartNode;
  processData: ProcessDataForNode;
  data: NodeRunDataWithRefs;
  isFrozen: boolean;
  isOutputExpanded: boolean;
  isHovered: boolean;
  processId: ProcessId;
  showNodeRunDuration: boolean;
  suppressDurationMeta?: boolean;
  onToggleExpandedOutput: () => void;
  onOpenFullscreenModal?: () => void;
}> = ({
  node,
  processData,
  data,
  isFrozen,
  isOutputExpanded,
  isHovered,
  processId,
  showNodeRunDuration,
  suppressDurationMeta = false,
  onToggleExpandedOutput,
  onOpenFullscreenModal,
}) => {
  const dataRefs = useDataRefs();
  const [isInspectorOpen, setInspectorOpen] = useState(false);
  const llmChatHistorySelectionKey = getLLMChatOutputHistorySelectionKey(node.id, processId, 0);
  const [selectedLLMChatOutputPage, setSelectedLLMChatOutputPage] = useAtom(
    selectedLLMChatOutputPageState(llmChatHistorySelectionKey),
  );
  const { Output, OutputSimple, getCopyValueData } = useUnknownNodeComponentDescriptorFor(node);

  const setOverlayOpen = useSetAtom(overlayOpenState);
  const setPromptDesignerAttachedNode = useSetAtom(promptDesignerAttachedChatNodeState);
  const io = useNodeIO(node.id);
  const presentationData = useMemo(
    () => (node.type === 'llmChatV2' ? getLLMChatSplitOutputHistoryPresentationData(data) : data),
    [data, node.type],
  );
  const hasSplitOutputData = presentationData.splitOutputData != null;
  const llmChatOutputHistory =
    node.type === 'llmChatV2' && !hasSplitOutputData ? data.llmChatOutputHistory?.[0] ?? [] : [];
  const displayedData = useMemo(
    () =>
      hasSplitOutputData
        ? presentationData
        : getSelectedLLMChatOutputHistoryData({
            data: presentationData,
            selectedPage: selectedLLMChatOutputPage,
          }),
    [hasSplitOutputData, presentationData, selectedLLMChatOutputPage],
  );

  const handleOpenPromptDesigner = () => {
    setOverlayOpen('promptDesigner');
    setPromptDesignerAttachedNode({
      nodeId: node.id,
      processId,
    });
  };

  const content = useMemo(
    () =>
      createNodeOutputContentViewModel({
        nodeType: node.type,
        data: displayedData,
        dataRefs,
        showNodeRunDuration,
      }),
    [dataRefs, displayedData, node.type, showNodeRunDuration],
  );
  const durationProcessData = useMemo(() => [{ processId, data: displayedData }], [displayedData, processId]);
  const showDurationSummary =
    !suppressDurationMeta && shouldShowNodeRunDurationSummary(node.type, durationProcessData, showNodeRunDuration);
  const showDurationMeta =
    !suppressDurationMeta &&
    !showDurationSummary &&
    shouldShowNodeRunDurationMeta(node.type, displayedData, showNodeRunDuration);

  const copySource = getNodeOutputCopySource(content);
  const handleCopyToClipboard = useStableCallback(() =>
      copyOutputValue(copySource, dataRefs, getCopyValueData, io.outputDefinitions),
  );
  const hasPromptDesignerAction = node.type === 'llmChatV2' && (node as LLMChatV2Node).data.configurationMode !== 'profile';
  const hasResponseInspectorAction = node.type === 'llmChatV2';
  const responseTrace = useMemo(() => buildLlmInvocationTrace(node, processData), [node, processData]);
  const responseInspector = isInspectorOpen ? (
    <AgentResponseInspector trace={responseTrace} onClose={() => setInspectorOpen(false)} renderInPortal />
  ) : null;
  const llmChatOutputHistoryPager = (
    <LLMChatOutputHistoryPager
      entries={llmChatOutputHistory}
      forceVisible={shouldShowLLMChatOutputHistoryPager({
        entries: llmChatOutputHistory,
        hasTerminalOutput: data.outputData != null,
      })}
      showLivePage={data.status?.type === 'running' && data.outputData != null}
      selectedPage={selectedLLMChatOutputPage}
      onSelectPage={setSelectedLLMChatOutputPage}
    />
  );
  const outputInnerClassName =
    hasPromptDesignerAction || hasResponseInspectorAction
      ? 'node-output-inner has-output-actions has-extra-output-action'
      : 'node-output-inner has-output-actions';
  const erroredOutputInnerClassName = `${outputInnerClassName} errored`;

  if (content.kind === 'code-error') {
    const contentKey = getNodeOutputContentKey(processId, displayedData, content.contentKeyKind);

    return (
      <div className={erroredOutputInnerClassName}>
        <NodeOutputOverlayButtons
          hasPromptDesignerAction={hasPromptDesignerAction}
          hasResponseInspectorAction={hasResponseInspectorAction}
          onCopyToClipboard={handleCopyToClipboard}
          onOpenFullscreenModal={onOpenFullscreenModal}
          onOpenPromptDesigner={handleOpenPromptDesigner}
          onOpenResponseInspector={() => setInspectorOpen(true)}
          onToggleExpandedOutput={onToggleExpandedOutput}
        />
        {responseInspector}
        {llmChatOutputHistoryPager}
        <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
          {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody />}
          {showDurationMeta && <NodeRunDurationMeta data={displayedData} hasBody />}
          <CodeNodeErrorOutput data={displayedData} />
        </NodeOutputContentFade>
      </div>
    );
  }

  if (content.kind === 'generic-error') {
    const contentKey = getNodeOutputContentKey(processId, displayedData, content.contentKeyKind);

    return (
      <div className={erroredOutputInnerClassName}>
        <NodeOutputOverlayButtons
          hasPromptDesignerAction={hasPromptDesignerAction}
          hasResponseInspectorAction={hasResponseInspectorAction}
          onCopyToClipboard={handleCopyToClipboard}
          onOpenFullscreenModal={onOpenFullscreenModal}
          onOpenPromptDesigner={handleOpenPromptDesigner}
          onOpenResponseInspector={() => setInspectorOpen(true)}
          onToggleExpandedOutput={onToggleExpandedOutput}
        />
        {responseInspector}
        {llmChatOutputHistoryPager}
        <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
          {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody />}
          {showDurationMeta && <NodeRunDurationMeta data={displayedData} hasBody />}
          <div className="node-output-error-message">{content.error}</div>
        </NodeOutputContentFade>
      </div>
    );
  }

  if (content.kind === 'empty') {
    return null;
  }

  const { isCompact, renderMode } = resolveNodeOutputPreviewMode({
    isOutputExpanded,
    isHovered,
  });

  const body = renderNodeOutputBody({
    Output,
    OutputSimple,
    node,
    data: displayedData,
    definitions: io.outputDefinitions,
    isCompact,
    renderMode,
    renderSplitOutput:
      node.type === 'llmChatV2' && hasSplitOutputData
        ? ({ splitIndex, outputs }) => (
            <LLMChatSplitOutputHistory
              entries={data.llmChatOutputHistory?.[splitIndex]}
              hasTerminalOutput={data.splitOutputData?.[splitIndex] != null}
              isRunning={data.status?.type === 'running'}
              latestOutputs={outputs}
              nodeId={node.id}
              processId={processId}
              renderOutputs={(selectedOutputs) =>
                renderNodeOutputBody({
                  Output,
                  OutputSimple,
                  node,
                  data: { ...displayedData, outputData: selectedOutputs, splitOutputData: undefined },
                  definitions: io.outputDefinitions,
                  isCompact,
                  renderMode,
                })
              }
              splitIndex={splitIndex}
            />
          )
        : undefined,
  });
  const hasBody = body != null;
  const contentKey = getNodeOutputContentKey(processId, displayedData, content.contentKeyKind);

  return (
    <div className={outputInnerClassName}>
      <NodeOutputOverlayButtons
        hasPromptDesignerAction={hasPromptDesignerAction}
        hasResponseInspectorAction={hasResponseInspectorAction}
        onCopyToClipboard={handleCopyToClipboard}
        onOpenFullscreenModal={onOpenFullscreenModal}
        onOpenPromptDesigner={handleOpenPromptDesigner}
        onOpenResponseInspector={() => setInspectorOpen(true)}
        onToggleExpandedOutput={onToggleExpandedOutput}
      />
      {responseInspector}
      {isFrozen && <FrozenOutputNotice />}
      {llmChatOutputHistoryPager}
      <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
        {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody={hasBody} />}
        {showDurationMeta && <NodeRunDurationMeta data={displayedData} hasBody={hasBody} />}
        {content.kind === 'output' && content.errorMessage && (
          <div className="node-output-error-message">{content.errorMessage}</div>
        )}
        {body}
      </NodeOutputContentFade>
      {content.warnings && (
        <div className="node-output-warnings">
          {content.warnings.map((warning) => (
            <div className="node-output-warning" key={warning}>
              {warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const NodeOutputOverlayButtons: FC<{
  hasPromptDesignerAction: boolean;
  hasResponseInspectorAction: boolean;
  onCopyToClipboard: () => void;
  onOpenFullscreenModal?: () => void;
  onOpenPromptDesigner: () => void;
  onOpenResponseInspector: () => void;
  onToggleExpandedOutput: () => void;
}> = ({
  hasPromptDesignerAction,
  hasResponseInspectorAction,
  onCopyToClipboard,
  onOpenFullscreenModal,
  onOpenPromptDesigner,
  onOpenResponseInspector,
  onToggleExpandedOutput,
}) => {
  const handleOutputActionMouseDown = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
    // Output controls are hover affordances. Do not let clicking them focus the
    // draggable node root, otherwise the settings gear stays visible after leave.
    event.preventDefault();
    event.stopPropagation();
  });
  const handleOutputActionClick = useStableCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  });

  return (
    <div className="overlay-buttons" onMouseDown={handleOutputActionMouseDown} onClick={handleOutputActionClick}>
      <Tooltip content="Unfold output">
        <div
          className="output-toggle-button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpandedOutput();
          }}
        >
          <ExpandDownStopIcon />
        </div>
      </Tooltip>
      <Tooltip content="Copy node output to clipboard">
        <div className="copy-button" onClick={onCopyToClipboard}>
          <CopyIcon />
        </div>
      </Tooltip>

      {hasResponseInspectorAction && (
        <Tooltip content="Inspect response">
          <div className="response-inspector-button" onClick={onOpenResponseInspector}>
            <EyeIcon />
          </div>
        </Tooltip>
      )}

      {hasPromptDesignerAction && (
        <Tooltip content="Open chat in Prompt Designer">
          <div className="prompt-designer-button" onClick={onOpenPromptDesigner}>
            <FlaskIcon />
          </div>
        </Tooltip>
      )}
      <Tooltip content="Show full output">
        <div
          className="expand-button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenFullscreenModal?.();
          }}
        >
          <ExpandIcon />
        </div>
      </Tooltip>
    </div>
  );
};

const NodeOutputMultiProcess: FC<{
  node: ChartNode;
  data: ProcessDataForNode[];
  isFrozen: boolean;
  isOutputExpanded: boolean;
  isHovered: boolean;
  showNodeRunDuration: boolean;
  onToggleExpandedOutput: () => void;
  onOpenFullscreenModal?: () => void;
}> = ({
  node,
  data,
  isFrozen,
  isOutputExpanded,
  isHovered,
  showNodeRunDuration,
  onToggleExpandedOutput,
  onOpenFullscreenModal,
}) => {
  const [selectedPage, setSelectedPage] = useAtom(selectedProcessPageState(node.id));
  const selectedPageIndex = getSelectedProcessPageIndex(data, selectedPage);
  const displaySelectedPage: number | 'latest' =
    selectedPage === 'latest' ? 'latest' : selectedPageIndex ?? selectedPage;

  const prevPage = useStableCallback(() => {
    setSelectedPage((page) => {
      const pageNum = getSelectedProcessPageIndex(data, page) ?? 0;
      return pageNum > 0 ? pageNum - 1 : pageNum;
    });
  });

  const nextPage = useStableCallback(() => {
    setSelectedPage((page) => {
      const pageNum = getSelectedProcessPageIndex(data, page) ?? 0;
      return pageNum < data.length - 1 ? pageNum + 1 : pageNum;
    });
  });

  const selectedData = useMemo(() => getSelectedNodeOutputProcess(data, selectedPage), [data, selectedPage]);
  const showDurationSummary = shouldShowNodeRunDurationSummary(node.type, data, showNodeRunDuration);
  const selectedHasVisibleBody =
    selectedData != null && nodeRunDataHasVisibleOutput(node.type, selectedData.data, { showNodeRunDuration: false });

  return (
    <div className="node-output multi">
      <div className="multi-node-output">
        <NodeOutputPager
          selectedPage={displaySelectedPage}
          totalPages={data.length}
          onPrevPage={prevPage}
          onNextPage={nextPage}
          stopDoubleClickPropagation
        />
      </div>
      {showDurationSummary && <NodeRunDurationSummaryMeta processData={data} hasBody={selectedHasVisibleBody} />}
      {selectedData && (
        <NodeOutputSingleProcess
          data={selectedData.data}
          processData={selectedData}
          isFrozen={isFrozen}
          isOutputExpanded={isOutputExpanded}
          isHovered={isHovered}
          node={node}
          processId={selectedData.processId}
          showNodeRunDuration={showNodeRunDuration}
          suppressDurationMeta={showDurationSummary}
          onToggleExpandedOutput={onToggleExpandedOutput}
          onOpenFullscreenModal={onOpenFullscreenModal}
        />
      )}
    </div>
  );
};

const FrozenOutputNotice: FC = () => (
  <div className="frozen-output-notice" aria-label="Output is frozen">
    <SnowflakeIcon aria-hidden="true" focusable="false" />
    <span>Output is frozen</span>
  </div>
);
