import type { ChartNode, ProcessId } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import ExpandIcon from 'majesticons/line/maximize-line.svg?react';
import FlaskIcon from 'majesticons/line/flask-line.svg?react';
import type { FC, MouseEvent } from 'react';
import { useMemo } from 'react';
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
  lastRunDataState,
  resolvedGraphSelectionState,
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
import { CodeNodeErrorOutput } from '../nodes/CodeNode.js';
import {
  getNodeOutputContentKey,
  NodeOutputContentFade,
  useOutputDataWithReplacementGrace,
} from './NodeOutputContentState.js';
import { copyOutputValue } from './nodeOutputCopyActions.js';
import { NodeOutputPager } from './NodeOutputPager.js';
import { resolveNodeOutputPreviewMode } from './nodeOutputPreviewMode.js';
import {
  createNodeOutputContentViewModel,
  getNodeOutputCopySource,
  getSelectedNodeOutputProcess,
} from './nodeOutputViewModel.js';
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
  const { Output, OutputSimple, getCopyValueData } = useUnknownNodeComponentDescriptorFor(node);

  const setOverlayOpen = useSetAtom(overlayOpenState);
  const setPromptDesignerAttachedNode = useSetAtom(promptDesignerAttachedChatNodeState);
  const io = useNodeIO(node.id);

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
        data,
        dataRefs,
        showNodeRunDuration,
      }),
    [data, dataRefs, node.type, showNodeRunDuration],
  );
  const durationProcessData = useMemo(() => [{ processId, data }], [data, processId]);
  const showDurationSummary =
    !suppressDurationMeta && shouldShowNodeRunDurationSummary(node.type, durationProcessData, showNodeRunDuration);
  const showDurationMeta =
    !suppressDurationMeta &&
    !showDurationSummary &&
    shouldShowNodeRunDurationMeta(node.type, data, showNodeRunDuration);

  const copySource = getNodeOutputCopySource(content);
  const handleCopyToClipboard = useStableCallback(() =>
    copyOutputValue(copySource, dataRefs, getCopyValueData, io.outputDefinitions),
  );
  const hasPromptDesignerAction = node.type === 'chat';
  const outputInnerClassName = hasPromptDesignerAction
    ? 'node-output-inner has-output-actions has-prompt-designer-action'
    : 'node-output-inner has-output-actions';
  const erroredOutputInnerClassName = `${outputInnerClassName} errored`;

  if (content.kind === 'code-error') {
    const contentKey = getNodeOutputContentKey(processId, data, content.contentKeyKind);

    return (
      <div className={erroredOutputInnerClassName}>
        <NodeOutputOverlayButtons
          hasPromptDesignerAction={hasPromptDesignerAction}
          onCopyToClipboard={handleCopyToClipboard}
          onOpenFullscreenModal={onOpenFullscreenModal}
          onOpenPromptDesigner={handleOpenPromptDesigner}
          onToggleExpandedOutput={onToggleExpandedOutput}
        />
        <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
          {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody />}
          {showDurationMeta && <NodeRunDurationMeta data={data} hasBody />}
          <CodeNodeErrorOutput data={data} />
        </NodeOutputContentFade>
      </div>
    );
  }

  if (content.kind === 'generic-error') {
    const contentKey = getNodeOutputContentKey(processId, data, content.contentKeyKind);

    return (
      <div className={erroredOutputInnerClassName}>
        <NodeOutputOverlayButtons
          hasPromptDesignerAction={hasPromptDesignerAction}
          onCopyToClipboard={handleCopyToClipboard}
          onOpenFullscreenModal={onOpenFullscreenModal}
          onOpenPromptDesigner={handleOpenPromptDesigner}
          onToggleExpandedOutput={onToggleExpandedOutput}
        />
        <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
          {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody />}
          {showDurationMeta && <NodeRunDurationMeta data={data} hasBody />}
          {content.error}
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
    data,
    definitions: io.outputDefinitions,
    isCompact,
    renderMode,
  });
  const hasBody = body != null;
  const contentKey = getNodeOutputContentKey(processId, data, content.contentKeyKind);

  return (
    <div className={outputInnerClassName}>
      <NodeOutputOverlayButtons
        hasPromptDesignerAction={hasPromptDesignerAction}
        onCopyToClipboard={handleCopyToClipboard}
        onOpenFullscreenModal={onOpenFullscreenModal}
        onOpenPromptDesigner={handleOpenPromptDesigner}
        onToggleExpandedOutput={onToggleExpandedOutput}
      />
      {isFrozen && <FrozenOutputNotice />}
      <NodeOutputContentFade key={contentKey} contentKey={contentKey}>
        {showDurationSummary && <NodeRunDurationSummaryMeta processData={durationProcessData} hasBody={hasBody} />}
        {showDurationMeta && <NodeRunDurationMeta data={data} hasBody={hasBody} />}
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
  onCopyToClipboard: () => void;
  onOpenFullscreenModal?: () => void;
  onOpenPromptDesigner: () => void;
  onToggleExpandedOutput: () => void;
}> = ({
  hasPromptDesignerAction,
  onCopyToClipboard,
  onOpenFullscreenModal,
  onOpenPromptDesigner,
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
    selectedPage === 'latest' ? 'latest' : (selectedPageIndex ?? selectedPage);

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
