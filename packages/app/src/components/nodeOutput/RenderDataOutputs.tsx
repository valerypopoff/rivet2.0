import { css } from '@emotion/react';
import { type NodeOutputDefinition } from '@valerypopoff/rivet2-core';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import { useEffect, useState, type FC, type ReactNode } from 'react';
import Collapsible from 'react-collapsible';
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

  > .Collapsible {
    border: 1px solid var(--grey-darkish);
    border-radius: 8px;
    corner-shape: squircle;
    overflow: hidden;

    @supports not (corner-shape: squircle) {
      border-radius: 4px;
    }
  }

  > .Collapsible > .auto-collapsed-llm-diagnostic-output-toggle-container {
    background: transparent;
  }

  > .Collapsible > .auto-collapsed-llm-diagnostic-output-toggle-container.open {
    border-bottom: 1px solid var(--grey-darkish);
  }

  .auto-collapsed-llm-diagnostic-output-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--grey-lighter);
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 6px;
    margin: 0;
    padding: 8px 10px;
    text-align: left;
    width: 100%;

    &:hover {
      background: var(--grey-light-seethrougher);
      color: var(--foreground);
    }

    svg {
      flex: 0 0 auto;
      height: 16px;
      width: 16px;
    }
  }

  .auto-collapsed-llm-diagnostic-output-content {
    padding: 10px;
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
  const disclosureLabel = isMessageOutput ? 'message content' : label;
  const collapsedDescription = isMessageOutput
    ? `${messageCount.toLocaleString()} ${messageCount === 1 ? 'message' : 'messages'}`
    : `${sectionText.length.toLocaleString()} characters`;
  const renderToggle = (toggleOpen: boolean) => (
    <button type="button" className="auto-collapsed-llm-diagnostic-output-toggle" aria-expanded={toggleOpen}>
      {toggleOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}
      <span>{toggleOpen ? `Collapse ${disclosureLabel}` : `Show ${disclosureLabel} (${collapsedDescription})`}</span>
    </button>
  );

  return (
    <div css={autoCollapsedLlmDiagnosticOutputStyles} className="auto-collapsed-llm-diagnostic-output">
      <Collapsible
        open={open}
        handleTriggerClick={() => setIsOpen((current) => !current)}
        trigger={renderToggle(false)}
        triggerClassName="auto-collapsed-llm-diagnostic-output-toggle-container"
        triggerOpenedClassName="auto-collapsed-llm-diagnostic-output-toggle-container open"
        triggerWhenOpen={renderToggle(true)}
        transitionTime={150}
        easing="ease-out"
      >
        <div className="auto-collapsed-llm-diagnostic-output-content">{children}</div>
      </Collapsible>
    </div>
  );
};
