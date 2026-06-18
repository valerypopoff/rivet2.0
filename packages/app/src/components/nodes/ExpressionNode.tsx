import {
  EXPRESSION_OUTPUT_PORT_ID,
  type ExpressionNode,
  type Inputs,
  interpolateExpressionSource,
} from '@valerypopoff/rivet2-core';
import { type FC, useMemo } from 'react';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { tryRestoreStoredPortMap } from '../../utils/executionDataReaders.js';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { getExpressionPreviewSource, hasExpressionInterpolationInputs } from './expressionOutputUtils.js';
import { shouldShowStructuredOutputDetails } from './parsedSourceDisplayUtils.js';
import { StructuredNodeOutput, StructuredNodeOutputSection } from './StructuredNodeOutput.js';
import { getSortedRenderableSplitOutputEntries } from '../nodeOutput/splitOutputEntries.js';

const ExpressionNodeOutputBody: FC<{
  node: ExpressionNode;
  data: NodeRunDataWithRefs;
  renderMode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ node, data, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const errorMessage = data.status?.type === 'error' ? data.status.error : undefined;
  const hasError = data.status?.type === 'error';
  const dataRefs = useDataRefs();
  const expressionSource = getExpressionPreviewSource(node, data);
  const isCompactPreview = renderMode === 'compact';
  const showStructuredDetails = shouldShowStructuredOutputDetails(renderMode);
  const shouldShowParsedExpression = showStructuredDetails && hasExpressionInterpolationInputs(expressionSource);
  const splitOutputEntries = getSortedRenderableSplitOutputEntries(data.splitOutputData);
  const hasSplitOutputs = splitOutputEntries.length > 0;
  const parsedExpression = useMemo(
    () =>
      shouldShowParsedExpression
        ? interpolateExpressionSource(
            expressionSource,
            (tryRestoreStoredPortMap(data.inputData, dataRefs) as Inputs | undefined) ?? {},
          )
        : undefined,
    [data.inputData, dataRefs, expressionSource, shouldShowParsedExpression],
  );
  const renderValue = (outputs: NodeRunDataWithRefs['outputData']) => {
    const outputValue = outputs?.[EXPRESSION_OUTPUT_PORT_ID];
    if (outputValue == null) {
      return null;
    }

    return (
      <RenderDataValue
        value={outputValue}
        isCompact={isCompactPreview}
        mode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  };
  const renderResult = (outputs: NodeRunDataWithRefs['outputData'], key?: string) => {
    const renderedValue = renderValue(outputs);
    if (!renderedValue) {
      return null;
    }

    return (
      <StructuredNodeOutputSection label="Resulting value" key={key}>
        {renderedValue}
      </StructuredNodeOutputSection>
    );
  };

  if (!showStructuredDetails && !hasError) {
    return hasSplitOutputs ? (
      <div className="split-output">
        {splitOutputEntries.flatMap(([key, outputs]) => {
          const renderedValue = renderValue(outputs);
          return renderedValue ? [<div key={key}>{renderedValue}</div>] : [];
        })}
      </div>
    ) : (
      renderValue(data.outputData)
    );
  }

  return (
    <StructuredNodeOutput
      errorMessage={errorMessage}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
      parsedSource={shouldShowParsedExpression ? parsedExpression ?? '' : undefined}
      parsedSourceLanguage="javascript"
    >
      {!hasError && hasSplitOutputs && (
        <div className="split-output">{splitOutputEntries.map(([key, outputs]) => renderResult(outputs, key))}</div>
      )}
      {!hasError && !hasSplitOutputs && renderResult(data.outputData)}
    </StructuredNodeOutput>
  );
};

export const expressionNodeDescriptor: NodeComponentDescriptor<'expression'> = {
  Output: ({ node, data, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <ExpressionNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <ExpressionNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};
