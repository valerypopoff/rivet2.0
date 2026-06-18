import { css } from '@emotion/react';
import { type FC, type ReactNode } from 'react';
import ColorizedPreformattedText from '../ColorizedPreformattedText.js';
import { FoldingCodeBlock } from '../renderDataValue/FoldingCodeBlock.js';
import { type OutputRenderMode } from '../renderDataValue/outputRenderTypes.js';
import { outputSectionGroupGap, outputSectionLabelStyles } from '../renderDataValue/renderDataValueStyles.js';

const structuredNodeOutputCss = css`
  display: block;

  .structured-node-output-section + .structured-node-output-section {
    margin-top: ${outputSectionGroupGap};
  }

  .structured-node-output-section {
    display: block;
  }

  .structured-node-output-section > * + * {
    margin-top: 6px;
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
  }
`;

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
  const placeParsedSourceBeforeChildren = useFoldableParsedSource && errorMessage === undefined;
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
    <div css={structuredNodeOutputCss}>
      {errorMessage !== undefined && <div className="structured-node-output-error">{errorMessage}</div>}
      {placeParsedSourceBeforeChildren && parsedSourceSection}
      {children}
      {!placeParsedSourceBeforeChildren && parsedSourceSection}
    </div>
  );
};

export const StructuredNodeOutputSection: FC<{
  children: ReactNode;
  className?: string;
  label: string;
}> = ({ children, className, label }) => (
  <div className={className ? `structured-node-output-section ${className}` : 'structured-node-output-section'}>
    <div>
      <em css={outputSectionLabelStyles} className="port-id-label">
        {label}
      </em>
    </div>
    {children}
  </div>
);

const ParsedSourceOutputSection: FC<{
  label: string;
  language: string;
  source: string;
  useFolding: boolean;
  wrapLines: boolean;
}> = ({ label, language, source, useFolding, wrapLines }) => (
  <StructuredNodeOutputSection label={label} className="structured-node-output-source">
    {useFolding ? (
      <FoldingCodeBlock text={source} language={language} wrapLines={wrapLines} />
    ) : (
      <ColorizedPreformattedText text={source} language={language} />
    )}
  </StructuredNodeOutputSection>
);
