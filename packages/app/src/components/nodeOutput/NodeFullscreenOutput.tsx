import { css } from '@emotion/react';
import { type ChartNode, type LLMChatV2Node, type ProcessId } from '@valerypopoff/rivet2-core';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { type FC, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useToggle } from 'ahooks';
import { useNodeIO } from '../../hooks/useGetNodeIO.js';
import { useStableCallback } from '../../hooks/useStableCallback.js';
import { useUnknownNodeComponentDescriptorFor } from '../../hooks/useNodeTypes.js';
import { useDependsOnPlugins } from '../../hooks/useDependsOnPlugins.js';
import { type HorizontalModalBounds } from '../../utils/fullScreenModalBounds.js';
import { promptDesignerAttachedChatNodeState } from '../../state/promptDesigner.js';
import { graphMetadataState, nodesByIdState } from '../../state/graph.js';
import {
  getLLMChatOutputHistorySelectionKey,
  lastRunDataState,
  resolvedGraphSelectionState,
  selectedLLMChatOutputPageState,
  selectedProcessPageState,
} from '../../state/dataFlow.js';
import { showNodeRunDurationsState } from '../../state/settings.js';
import {
  filterProcessDataForSelection,
  getSelectedProcessPageIndex,
} from '../../state/selectors/executionSelectors.js';
import { fullscreenOutputNodeState, hoveringNodeState } from '../../state/graphBuilder.js';
import { fullscreenOutputModalBoundsState, overlayOpenState } from '../../state/ui.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { FullScreenModal } from '../FullScreenModal.js';
import { AgentResponseInspector } from '../agentTrace/AgentResponseInspector.js';
import { buildLlmInvocationTrace } from '../agentTrace/agentTraceViewModel.js';
import { CodeNodeErrorOutput } from '../nodes/CodeNode.js';
import { MATCH_ACTIVE_CLASS, MATCH_CLASS } from './fullscreenOutputSearch.js';
import { FullscreenNodeOutputToolbar } from './FullscreenNodeOutputToolbar.js';
import { FullscreenOutputSearchContext } from './FullscreenOutputSearchContext.js';
import { copyOutputJson, copyOutputValue } from './nodeOutputCopyActions.js';
import { NodeOutputPager } from './NodeOutputPager.js';
import { LLMChatOutputHistoryPager } from './LLMChatOutputHistoryPager.js';
import { LLMChatSplitOutputHistory } from './LLMChatSplitOutputHistory.js';
import { renderNodeOutputBody } from './renderNodeOutputBody.js';
import {
  NodeRunDurationMeta,
  NodeRunDurationSummaryMeta,
  shouldShowNodeRunDurationMeta,
  shouldShowNodeRunDurationSummary,
} from './NodeRunDurationMeta.js';
import { useFullscreenOutputSearch } from './useFullscreenOutputSearch.js';
import {
  createFullscreenNodeOutputViewModel,
  getNodeOutputCopySource,
  getSelectedNodeOutputProcess,
} from './nodeOutputViewModel.js';
import {
  getLLMChatSplitOutputHistoryPresentationData,
  getSelectedLLMChatOutputHistoryData,
  shouldShowLLMChatOutputHistoryPager,
} from '../../utils/llmChatOutputHistory.js';

export const FullscreenNodeOutputModalRenderer: FC = () => {
  useDependsOnPlugins();

  const fullscreenOutputNodeId = useAtomValue(fullscreenOutputNodeState);
  const setFullscreenOutputNodeId = useSetAtom(fullscreenOutputNodeState);
  const setHoveringNode = useSetAtom(hoveringNodeState);
  const nodesById = useAtomValue(nodesByIdState);
  const graphId = useAtomValue(graphMetadataState)?.id;
  const previousGraphIdRef = useRef(graphId);
  const node = fullscreenOutputNodeId ? nodesById[fullscreenOutputNodeId] : undefined;

  const handleCloseFullscreenModal = useStableCallback(() => {
    setHoveringNode((hoveringNodeId) =>
      fullscreenOutputNodeId && hoveringNodeId === fullscreenOutputNodeId ? undefined : hoveringNodeId,
    );
    setFullscreenOutputNodeId(null);
  });

  useEffect(() => {
    if (fullscreenOutputNodeId && !node) {
      setFullscreenOutputNodeId(null);
    }
  }, [fullscreenOutputNodeId, node, setFullscreenOutputNodeId]);

  useEffect(() => {
    if (previousGraphIdRef.current === graphId) {
      return;
    }

    previousGraphIdRef.current = graphId;
    setFullscreenOutputNodeId(null);
  }, [graphId, setFullscreenOutputNodeId]);

  useEffect(() => {
    return () => {
      setFullscreenOutputNodeId(null);
    };
  }, [setFullscreenOutputNodeId]);

  if (previousGraphIdRef.current !== graphId || !fullscreenOutputNodeId || !node) {
    return null;
  }

  return (
    <ResizableNodeFullscreenOutputModal key={fullscreenOutputNodeId} node={node} onClose={handleCloseFullscreenModal} />
  );
};

const ResizableNodeFullscreenOutputModal: FC<{ node: ChartNode; onClose: () => void }> = ({ node, onClose }) => {
  const [fullscreenOutputModalBounds, setFullscreenOutputModalBounds] = useAtom(fullscreenOutputModalBoundsState);
  const handleFullscreenOutputModalBoundsChange = useStableCallback((bounds: HorizontalModalBounds) => {
    setFullscreenOutputModalBounds(bounds);
  });

  return (
    <FullScreenModal
      isOpen
      horizontalBounds={fullscreenOutputModalBounds}
      onClose={onClose}
      onHorizontalBoundsChange={handleFullscreenOutputModalBoundsChange}
      testId="fullscreen-output-modal"
    >
      <NodeFullscreenOutput node={node} />
    </FullScreenModal>
  );
};

const fullscreenOutputCss = css`
  position: relative;
  min-height: 100%;
  display: flex;
  min-width: 0;
  flex-direction: column;

  .fullscreen-header {
    position: sticky;
    top: var(--fullscreen-modal-vertical-inset);
    z-index: 1;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .picker {
    border: 1px solid var(--grey-darkish);
    background: transparent;
    display: inline-flex;
    gap: 0;
    border-radius: 8px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 4px;
    }
    box-shadow: none;
    margin-bottom: 8px;

    .picker-left,
    .picker-right {
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      cursor: pointer;
      border: 0;
      margin: 0;
      padding: 0;
      width: 32px;
      height: 32px;

      &:hover {
        background: rgba(255, 255, 255, 0.1);
      }
    }

    .picker-left {
      border-right: 1px solid rgba(255, 255, 255, 0.1);
    }

    .picker-right {
      border-left: 1px solid rgba(255, 255, 255, 0.1);
    }

    .picker-page {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
    }
  }

  .fullscreen-output-body {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    box-sizing: border-box;
    padding-bottom: calc(24px * var(--ui-font-scale));
  }

  .fullscreen-output-pagers {
    display: flex;
    gap: 8px;
    min-width: 0;

    .picker {
      flex: 0 0 auto;
    }

    .picker.llm-chat-output-history-pager.compact {
      max-width: min(320px, 34vw);

      .picker-page.llm-chat-output-history-pager-label {
        flex: 1 1 auto;
        min-width: 0;
        width: auto;
        overflow: hidden;
        padding: 0 10px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }

  .fullscreen-output-body.wrap-lines .pre-wrap,
  .fullscreen-output-body.markdown-lines .rivet-markdown-output.markdown-body pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow-x: visible;
  }

  .fullscreen-output-body.wrap-lines .rendered-object-type pre {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
    overflow-x: visible;
  }

  .fullscreen-output-body.no-wrap-lines .pre-wrap,
  .fullscreen-output-body.no-wrap-lines .rendered-object-type pre {
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: visible;
  }

  .fullscreen-output-warnings {
    border-top: 1px solid var(--grey-light);
    color: var(--foreground-bright);
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    margin-top: 16px;
    padding-top: 12px;
  }

  .fullscreen-output-warning + .fullscreen-output-warning {
    margin-top: 8px;
  }

  .node-output-error-message {
    /* The red system-error background is sufficient; a border competes with
       the normal output sections below it. */
    background: var(--node-output-error-bg);
    border-radius: 4px;
    color: var(--foreground-bright);
    margin-bottom: 16px;
    overflow-wrap: anywhere;
    padding: 12px;
    white-space: pre-wrap;
  }

  .node-output-error-message:last-child {
    margin-bottom: 0;
  }

  .${MATCH_CLASS} {
    background: rgba(255, 214, 10, 0.3);
    border-radius: 4px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 2px;
    }
  }

  .${MATCH_ACTIVE_CLASS} {
    background: rgba(255, 214, 10, 0.75);
    color: #000;
  }
`;

const NodeFullscreenOutput: FC<{ node: ChartNode }> = ({ node }) => {
  const dataRefs = useDataRefs();
  const output = useAtomValue(lastRunDataState(node.id));
  const [selectedPage, setSelectedPage] = useAtom(selectedProcessPageState(node.id));
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
  const showNodeRunDurations = useAtomValue(showNodeRunDurationsState);
  const [isInspectorOpen, setInspectorOpen] = useState(false);

  const filteredOutput = useMemo(
    () => filterProcessDataForSelection({ ...graphSelectionOptions, processData: output }),
    [graphSelectionOptions, output],
  );
  const selectedPageIndex = getSelectedProcessPageIndex(filteredOutput, selectedPage);
  const displaySelectedPage: number | 'latest' =
    selectedPage === 'latest' ? 'latest' : selectedPageIndex ?? selectedPage;
  const selectedProcessData = useMemo(
    () => getSelectedNodeOutputProcess(filteredOutput ?? [], selectedPage),
    [filteredOutput, selectedPage],
  );
  const llmChatHistorySelectionKey = getLLMChatOutputHistorySelectionKey(
    node.id,
    selectedProcessData?.processId ?? ('no-process' as ProcessId),
    0,
  );
  const [selectedLLMChatOutputPage, setSelectedLLMChatOutputPage] = useAtom(
    selectedLLMChatOutputPageState(llmChatHistorySelectionKey),
  );
  const selectedPresentationData = useMemo(
    () =>
      selectedProcessData && node.type === 'llmChatV2'
        ? getLLMChatSplitOutputHistoryPresentationData(selectedProcessData.data, node.isSplitRun === true)
        : selectedProcessData?.data,
    [node.isSplitRun, node.type, selectedProcessData],
  );
  const hasSelectedSplitOutputData = selectedPresentationData?.splitOutputData != null;
  const displayedOutput = useMemo(() => {
    if (!selectedProcessData || !filteredOutput) {
      return filteredOutput;
    }

    return filteredOutput.map((process) => {
      if (process.processId !== selectedProcessData.processId) {
        return process;
      }

      const presentationData = selectedPresentationData ?? process.data;
      return {
        ...process,
        data: hasSelectedSplitOutputData
          ? presentationData
          : getSelectedLLMChatOutputHistoryData({
              data: presentationData,
              selectedPage: selectedLLMChatOutputPage,
            }),
      };
    });
  }, [
    filteredOutput,
    hasSelectedSplitOutputData,
    selectedLLMChatOutputPage,
    selectedPresentationData,
    selectedProcessData,
  ]);

  const { FullscreenOutput, Output, OutputSimple, FullscreenOutputSimple, defaultRenderMarkdown, getCopyValueData } =
    useUnknownNodeComponentDescriptorFor(node);

  const [wrapLines, toggleWrapLines] = useToggle(true);
  const [renderMarkdown, toggleRenderMarkdown] = useToggle(defaultRenderMarkdown ?? false);

  const setOverlayOpen = useSetAtom(overlayOpenState);
  const setPromptDesignerAttachedNode = useSetAtom(promptDesignerAttachedChatNodeState);

  const io = useNodeIO(node.id);

  const outputViewModel = useMemo(
    () =>
      createFullscreenNodeOutputViewModel({
        nodeType: node.type,
        processData: displayedOutput,
        selectedPage,
        dataRefs,
        showNodeRunDuration: showNodeRunDurations,
      }),
    [dataRefs, displayedOutput, node.type, selectedPage, showNodeRunDurations],
  );
  const { data, processId } = outputViewModel;
  const responseTrace = useMemo(() => buildLlmInvocationTrace(node, selectedProcessData), [node, selectedProcessData]);
  const llmChatOutputHistory =
    node.type === 'llmChatV2' && !hasSelectedSplitOutputData
      ? selectedProcessData?.data.llmChatOutputHistory?.[0] ?? []
      : [];
  const forceLlmChatOutputHistoryPager = shouldShowLLMChatOutputHistoryPager({
    entries: llmChatOutputHistory,
    hasTerminalOutput: selectedProcessData?.data.outputData != null,
  });
  const showLiveLlmChatOutputHistoryPage =
    selectedProcessData?.data.status?.type === 'running' && selectedProcessData.data.outputData != null;
  const hasLlmChatOutputHistoryPager =
    llmChatOutputHistory.length > 0 &&
    (llmChatOutputHistory.length > 1 || forceLlmChatOutputHistoryPager || showLiveLlmChatOutputHistoryPage);
  const llmChatOutputHistoryPager = hasLlmChatOutputHistoryPager ? (
    <LLMChatOutputHistoryPager
      compact
      entries={llmChatOutputHistory}
      forceVisible={forceLlmChatOutputHistoryPager}
      showLivePage={showLiveLlmChatOutputHistoryPage}
      selectedPage={selectedLLMChatOutputPage}
      onSelectPage={setSelectedLLMChatOutputPage}
    />
  ) : null;

  const handleOpenPromptDesigner = () => {
    if (!processId) {
      return;
    }

    setOverlayOpen('promptDesigner');
    setPromptDesignerAttachedNode({
      nodeId: node.id,
      processId,
    });
  };

  const copySource = getNodeOutputCopySource(outputViewModel.content);
  const handleCopyToClipboard = useStableCallback(() =>
    copyOutputValue(copySource, dataRefs, getCopyValueData, io.outputDefinitions),
  );
  const handleCopyToClipboardJson = useStableCallback(() => copyOutputJson(copySource, dataRefs));
  const durationSummaryKey = useMemo(
    () =>
      filteredOutput
        ?.map(
          (process) =>
            `${process.processId}:${process.data.status?.type ?? ''}:${process.data.durationMs ?? ''}:${JSON.stringify(
              process.data.splitRunDurationMs ?? {},
            )}`,
        )
        .join('|') ?? '',
    [filteredOutput],
  );
  const contentVersion = useMemo(
    () => ({
      data,
      durationSummaryKey,
      processId,
      renderMarkdown,
      selectedPage: displaySelectedPage,
      selectedLLMChatOutputPage,
      showNodeRunDurations,
    }),
    [
      data,
      displaySelectedPage,
      durationSummaryKey,
      processId,
      renderMarkdown,
      selectedLLMChatOutputPage,
      showNodeRunDurations,
    ],
  );
  const {
    contextValue: fullscreenOutputSearchContext,
    currentMatchIndex,
    fullscreenOutputBodyRef,
    goToNextMatch,
    goToPreviousMatch,
    handleSearchInputKeyDown,
    query,
    searchInputRef,
    setQuery,
    totalMatchCount,
  } = useFullscreenOutputSearch({
    contentKey: contentVersion,
  });

  const prevPage = useStableCallback(() => {
    if (!filteredOutput) {
      return;
    }
    setSelectedPage((page) => {
      const pageNum = getSelectedProcessPageIndex(filteredOutput, page) ?? 0;
      return pageNum > 0 ? pageNum - 1 : pageNum;
    });
  });

  const nextPage = useStableCallback(() => {
    if (!filteredOutput) {
      return;
    }
    setSelectedPage((page) => {
      const pageNum = getSelectedProcessPageIndex(filteredOutput, page) ?? 0;
      return pageNum < filteredOutput.length - 1 ? pageNum + 1 : pageNum;
    });
  });

  if (outputViewModel.kind === 'empty') {
    return null;
  }

  const { content, data: selectedData } = outputViewModel;
  const showDurationSummary = shouldShowNodeRunDurationSummary(node.type, filteredOutput, showNodeRunDurations);
  const showDurationMeta =
    !showDurationSummary && shouldShowNodeRunDurationMeta(node.type, selectedData, showNodeRunDurations);

  let outputBody: ReactNode;

  if (content.kind === 'code-error') {
    outputBody = (
      <>
        {showDurationSummary && filteredOutput && <NodeRunDurationSummaryMeta processData={filteredOutput} hasBody />}
        {showDurationMeta && <NodeRunDurationMeta data={selectedData} hasBody />}
        <CodeNodeErrorOutput data={selectedData} />
      </>
    );
  } else if (content.kind === 'generic-error') {
    outputBody = (
      <div className="errored">
        {showDurationSummary && filteredOutput && <NodeRunDurationSummaryMeta processData={filteredOutput} hasBody />}
        {showDurationMeta && <NodeRunDurationMeta data={selectedData} hasBody />}
        <div className="node-output-error-message">{content.error}</div>
      </div>
    );
  } else {
    const body = renderNodeOutputBody({
      FullscreenOutput,
      Output,
      OutputSimple,
      FullscreenOutputSimple,
      node,
      data: selectedData,
      definitions: io.outputDefinitions,
      isCompact: false,
      renderMarkdown,
      renderMode: 'expanded-preview',
      allowLargeStoredValueActions: true,
      autoCollapseLlmChatDiagnosticOutputs: node.type === 'llmChatV2',
      wrapLines,
      renderSplitOutput:
        node.type === 'llmChatV2' && hasSelectedSplitOutputData && selectedProcessData
          ? ({ splitIndex, outputs }) => (
              <LLMChatSplitOutputHistory
                entries={selectedProcessData.data.llmChatOutputHistory?.[splitIndex]}
                hasTerminalOutput={selectedProcessData.data.splitOutputData?.[splitIndex] != null}
                isRunning={selectedProcessData.data.status?.type === 'running'}
                latestOutputs={outputs}
                nodeId={node.id}
                processId={selectedProcessData.processId}
                renderOutputs={(selectedOutputs) =>
                  renderNodeOutputBody({
                    FullscreenOutput,
                    Output,
                    OutputSimple,
                    FullscreenOutputSimple,
                    node,
                    data: { ...selectedData, outputData: selectedOutputs, splitOutputData: undefined },
                    definitions: io.outputDefinitions,
                    isCompact: false,
                    renderMarkdown,
                    renderMode: 'expanded-preview',
                    allowLargeStoredValueActions: true,
                    autoCollapseLlmChatDiagnosticOutputs: true,
                    wrapLines,
                  })
                }
                splitIndex={splitIndex}
              />
            )
          : undefined,
    });
    const hasBody = body != null;

    outputBody = (
      <>
        {showDurationSummary && filteredOutput && (
          <NodeRunDurationSummaryMeta processData={filteredOutput} hasBody={hasBody} />
        )}
        {showDurationMeta && <NodeRunDurationMeta data={selectedData} hasBody={hasBody} />}
        {content.kind === 'output' && content.errorMessage && (
          <div className="node-output-error-message">{content.errorMessage}</div>
        )}
        {body}
        {content.warnings && (
          <div className="fullscreen-output-warnings">
            {content.warnings.map((warning) => (
              <div className="fullscreen-output-warning" key={warning}>
                {warning}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div css={fullscreenOutputCss}>
      <header className="fullscreen-header">
        <div className="fullscreen-output-pagers">
          {outputViewModel.totalPages > 1 && (
            <NodeOutputPager
              selectedPage={displaySelectedPage}
              totalPages={outputViewModel.totalPages}
              onPrevPage={prevPage}
              onNextPage={nextPage}
            />
          )}
          {llmChatOutputHistoryPager}
        </div>
        <FullscreenNodeOutputToolbar
          wrapLines={wrapLines}
          renderMarkdown={renderMarkdown}
          onToggleWrapLines={toggleWrapLines.toggle}
          onToggleRenderMarkdown={toggleRenderMarkdown.toggle}
          query={query}
          onQueryChange={setQuery}
          currentMatchIndex={currentMatchIndex}
          totalMatchCount={totalMatchCount}
          onPreviousMatch={goToPreviousMatch}
          onNextMatch={goToNextMatch}
          searchInputRef={searchInputRef}
          onSearchInputKeyDown={handleSearchInputKeyDown}
          onCopyValue={handleCopyToClipboard}
          onCopyJson={handleCopyToClipboardJson}
          onOpenPromptDesigner={
            node.type === 'llmChatV2' && (node as LLMChatV2Node).data.configurationMode !== 'profile'
              ? handleOpenPromptDesigner
              : undefined
          }
          onInspectResponse={node.type === 'llmChatV2' ? () => setInspectorOpen(true) : undefined}
        />
      </header>

      <FullscreenOutputSearchContext.Provider value={fullscreenOutputSearchContext}>
        <div
          ref={fullscreenOutputBodyRef}
          className={`fullscreen-output-body ${wrapLines ? 'wrap-lines' : 'no-wrap-lines'}${
            renderMarkdown ? ' markdown-lines' : ''
          }`}
        >
          {outputBody}
        </div>
      </FullscreenOutputSearchContext.Provider>
      {isInspectorOpen && (
        <AgentResponseInspector trace={responseTrace} onClose={() => setInspectorOpen(false)} renderInPortal />
      )}
    </div>
  );
};
