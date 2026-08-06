import { css } from '@emotion/react';
import { type NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import { useEffect, useState, type FC, type ReactNode } from 'react';
import { type DataRefReader, useDataRefs } from '../../providers/ProvidersContext.js';
import { type InputsOrOutputsWithRefs } from '../../state/dataFlow.js';
import { RenderDataValue } from '../RenderDataValue.js';
import { OutputSectionHeader } from '../renderDataValue/OutputSectionHeader.js';
import type { OutputRenderMode } from '../renderDataValue/outputRenderTypes.js';
import {
  getOutputSectionArrayItemCount,
  getOutputSectionStatsForValue,
  getOutputSectionTextForValue,
  shouldShowOutputSectionStats,
} from '../renderDataValue/outputSectionStats.js';
import { renderedDataOutputsStyles } from '../renderDataValue/renderDataValueStyles.js';
import { serializeDisplayedPortValue } from '../../utils/executionDataCopyValue.js';
import { useFullscreenOutputSearchContext } from './FullscreenOutputSearchContext.js';
import { createNodeOutputSectionsViewModel } from './nodeOutputViewModel.js';
import { CollapsiblePanel } from '../CollapsiblePanel.js';

const LLM_CHAT_LARGE_DIAGNOSTIC_OUTPUT_PORT_IDS = new Set([
  'all-messages',
  'function-calls',
  'in-messages',
  'llmAttempts',
  'reasoning',
]);
const LLM_CHAT_MESSAGE_OUTPUT_PORT_IDS = new Set(['all-messages', 'in-messages']);
const LLM_CHAT_LARGE_DIAGNOSTIC_AUTO_COLLAPSE_CHARS = 1_000;

const autoCollapsedLlmDiagnosticOutputStyles = css`
  margin-top: 8px;

  .auto-collapsed-llm-diagnostic-output-content {
    padding: calc(16px * var(--ui-font-scale));
  }
`;

export const RenderDataOutputs: FC<{
  definitions?: readonly Pick<NodeOutputDefinition, 'id' | 'title'>[];
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown?: boolean;
  isCompact: boolean;
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  autoCollapseLlmChatDiagnosticOutputs?: boolean;
  wrapLines?: boolean;
}> = ({
  definitions,
  outputs,
  renderMarkdown,
  isCompact,
  mode,
  allowLargeStoredValueActions,
  autoCollapseLlmChatDiagnosticOutputs = false,
  wrapLines,
}) => {
  const dataRefs = useDataRefs();
  const effectiveMode = mode ?? (isCompact ? 'compact' : 'full');
  const showSectionStats = shouldShowOutputSectionStats({
    mode: effectiveMode,
    allowLargeStoredValueActions,
  });
  const sections = createNodeOutputSectionsViewModel({
    definitions,
    outputs,
    isCompact,
    showLargeHeaders: showSectionStats,
  });

  if (sections.length === 0) {
    return null;
  }

  if (sections.length === 1 && sections[0]?.headerMode === 'hidden') {
    const section = sections[0]!;
    return (
      <div>
        <RenderDataValue
          value={section.value}
          renderMarkdown={renderMarkdown}
          isCompact={isCompact}
          mode={effectiveMode}
          allowLargeStoredValueActions={allowLargeStoredValueActions}
          wrapLines={wrapLines}
        />
      </div>
    );
  }

  return (
    <div
      css={renderedDataOutputsStyles}
      className={showSectionStats ? 'rendered-data-outputs large-output-sections' : 'rendered-data-outputs'}
    >
      {sections.map((section) => (
        <OutputSection
          key={section.portId}
          section={section}
          outputs={outputs}
          dataRefs={dataRefs}
          renderMarkdown={renderMarkdown}
          isCompact={isCompact}
          effectiveMode={effectiveMode}
          allowLargeStoredValueActions={allowLargeStoredValueActions}
          autoCollapseLlmChatDiagnosticOutputs={autoCollapseLlmChatDiagnosticOutputs}
          wrapLines={wrapLines}
        />
      ))}
    </div>
  );
};

type OutputSectionViewModel = ReturnType<typeof createNodeOutputSectionsViewModel>[number];

const OutputSection: FC<{
  section: OutputSectionViewModel;
  outputs: InputsOrOutputsWithRefs;
  dataRefs: DataRefReader;
  renderMarkdown: boolean | undefined;
  isCompact: boolean;
  effectiveMode: OutputRenderMode;
  allowLargeStoredValueActions: boolean | undefined;
  autoCollapseLlmChatDiagnosticOutputs: boolean;
  wrapLines: boolean | undefined;
}> = ({
  section,
  outputs,
  dataRefs,
  renderMarkdown,
  isCompact,
  effectiveMode,
  allowLargeStoredValueActions,
  autoCollapseLlmChatDiagnosticOutputs,
  wrapLines,
}) => {
  const isEligibleLlmChatDiagnosticOutput =
    autoCollapseLlmChatDiagnosticOutputs && LLM_CHAT_LARGE_DIAGNOSTIC_OUTPUT_PORT_IDS.has(section.portId);
  const sectionText = isEligibleLlmChatDiagnosticOutput
    ? getOutputSectionTextForValue(section.value, dataRefs)
    : undefined;
  const shouldAutoCollapse =
    !isCompact &&
    effectiveMode === 'expanded-preview' &&
    isEligibleLlmChatDiagnosticOutput &&
    (sectionText?.length ?? 0) >= LLM_CHAT_LARGE_DIAGNOSTIC_AUTO_COLLAPSE_CHARS;
  const messageCount = LLM_CHAT_MESSAGE_OUTPUT_PORT_IDS.has(section.portId)
    ? getOutputSectionArrayItemCount(section.value, dataRefs)
    : undefined;
  const outputValue = (
    <RenderDataValue
      value={section.value}
      renderMarkdown={renderMarkdown}
      isCompact={isCompact}
      mode={effectiveMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  );

  return (
    <div className="port-value">
      <OutputSectionHeader
        getCopyValue={
          section.headerMode === 'large'
            ? () => serializeDisplayedPortValue(outputs, section.portId, dataRefs)
            : undefined
        }
        isLarge={section.headerMode === 'large'}
        label={section.label}
        stats={section.headerMode === 'large' ? getOutputSectionStatsForValue(section.value, dataRefs) : undefined}
      />
      {shouldAutoCollapse ? (
        <AutoCollapsedLlmDiagnosticOutput label={section.label} messageCount={messageCount} sectionText={sectionText!}>
          {outputValue}
        </AutoCollapsedLlmDiagnosticOutput>
      ) : (
        outputValue
      )}
    </div>
  );
};

const AutoCollapsedLlmDiagnosticOutput: FC<{
  label: string;
  messageCount?: number;
  sectionText: string;
  children: ReactNode;
}> = ({ label, messageCount, sectionText, children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const searchQuery = useFullscreenOutputSearchContext()?.query ?? '';
  const open = isOpen || searchQuery.trim().length > 0;

  useEffect(() => {
    setIsOpen(false);
  }, [sectionText]);

  const isMessageOutput = messageCount !== undefined;
  const collapsedDescription = isMessageOutput
    ? `${messageCount.toLocaleString()} ${messageCount === 1 ? 'message' : 'messages'}`
    : `${sectionText.length.toLocaleString()} characters`;

  return (
    <div css={autoCollapsedLlmDiagnosticOutputStyles} className="auto-collapsed-llm-diagnostic-output">
      <CollapsiblePanel
        open={open}
        onToggle={() => setIsOpen((current) => !current)}
        label={`${label} (${collapsedDescription})`}
      >
        <div className="auto-collapsed-llm-diagnostic-output-content">{children}</div>
      </CollapsiblePanel>
    </div>
  );
};
