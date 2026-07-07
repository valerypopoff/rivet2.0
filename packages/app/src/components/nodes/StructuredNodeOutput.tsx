import { css } from '@emotion/react';
import { createContext, type FC, type ReactNode, useContext } from 'react';
import type { DataValue } from '@valerypopoff/rivet2-core';
import ColorizedPreformattedText from '../ColorizedPreformattedText.js';
import { FoldingCodeBlock } from '../renderDataValue/FoldingCodeBlock.js';
import { type OutputRenderMode } from '../renderDataValue/outputRenderTypes.js';
import {
  outputSectionFullscreenGroupGap,
  outputSectionGroupGap,
} from '../renderDataValue/renderDataValueStyles.js';
import { OutputSectionHeader } from '../renderDataValue/OutputSectionHeader.js';
import {
  getOutputSectionStatsForValue,
  getOutputSectionStatsFromText,
  shouldShowOutputSectionStats,
} from '../renderDataValue/outputSectionStats.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import type { DataValueWithRefs } from '../../state/dataFlow.js';
import { serializeDisplayedDataValue } from '../../utils/executionDataCopyValue.js';

const structuredNodeOutputCss = css`
  display: block;

  &.large-output-sections {
    --output-section-group-gap: ${outputSectionFullscreenGroupGap};
  }

  .structured-node-output-section + .structured-node-output-section {
    margin-top: var(--output-section-group-gap, ${outputSectionGroupGap});
  }

  .structured-node-output-section {
    display: block;
  }

  .structured-node-output-section > * + * {
    margin-top: 6px;
  }

  .output-section-header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: calc(10px * var(--ui-font-scale));
  }

  .structured-node-output-source pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fullscreen-output-body.wrap-lines & .structured-node-output-source pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .fullscreen-output-body.no-wrap-lines & .structured-node-output-source pre {
    white-space: pre;
    overflow-wrap: normal;
  }

  .structured-node-output-error {
    color: var(--error-light);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .structured-node-output-error:not(:last-child) {
    margin-bottom: var(--output-section-group-gap, ${outputSectionGroupGap});
  }
`;

const StructuredNodeOutputStatsContext = createContext(false);

export const StructuredNodeOutput: FC<{
  children?: ReactNode;
  errorMessage?: string;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
  parsedSource?: string;
  parsedSourceLabel?: string;
  parsedSourceLanguage?: string;
}> = ({
  children,
  errorMessage,
  renderMode,
  allowLargeStoredValueActions,
  wrapLines,
  parsedSource,
  parsedSourceLabel,
  parsedSourceLanguage,
}) => {
  const useFoldableParsedSource = renderMode === 'expanded-preview' && allowLargeStoredValueActions === true;
  const showSectionStats = shouldShowOutputSectionStats({ mode: renderMode, allowLargeStoredValueActions });
  const parsedSourceSection =
    parsedSource !== undefined && parsedSourceLanguage ? (
      <ParsedSourceOutputSection
        label={parsedSourceLabel ?? 'Parsed expression'}
        source={parsedSource}
        language={parsedSourceLanguage}
        useFolding={useFoldableParsedSource}
        wrapLines={wrapLines ?? true}
      />
    ) : null;

  return (
    <StructuredNodeOutputStatsContext.Provider value={showSectionStats}>
      <div css={structuredNodeOutputCss} className={showSectionStats ? 'large-output-sections' : undefined}>
        {errorMessage !== undefined && <div className="structured-node-output-error">{errorMessage}</div>}
        {children}
        {parsedSourceSection}
      </div>
    </StructuredNodeOutputStatsContext.Provider>
  );
};

export const StructuredNodeOutputSection: FC<{
  children: ReactNode;
  className?: string;
  label: string;
  statsText?: string;
  statsValue?: DataValueWithRefs | DataValue;
}> = ({ children, className, label, statsText, statsValue }) => {
  const dataRefs = useDataRefs();
  const showSectionStats = useContext(StructuredNodeOutputStatsContext);
  const stats = showSectionStats
    ? statsText !== undefined
      ? getOutputSectionStatsFromText(statsText)
      : getOutputSectionStatsForValue(statsValue, dataRefs)
    : undefined;
  const getCopyValue =
    showSectionStats && (statsText !== undefined || statsValue !== undefined)
      ? () => statsText ?? serializeDisplayedDataValue(statsValue, dataRefs)
      : undefined;

  return (
    <div className={className ? `structured-node-output-section ${className}` : 'structured-node-output-section'}>
      <OutputSectionHeader getCopyValue={getCopyValue} isLarge={showSectionStats} label={label} stats={stats} />
      {children}
    </div>
  );
};

const ParsedSourceOutputSection: FC<{
  label: string;
  language: string;
  source: string;
  useFolding: boolean;
  wrapLines: boolean;
}> = ({ label, language, source, useFolding, wrapLines }) => (
  <StructuredNodeOutputSection label={label} className="structured-node-output-source" statsText={source}>
    {useFolding ? (
      <FoldingCodeBlock text={source} language={language} wrapLines={wrapLines} />
    ) : (
      <ColorizedPreformattedText text={source} language={language} />
    )}
  </StructuredNodeOutputSection>
);
