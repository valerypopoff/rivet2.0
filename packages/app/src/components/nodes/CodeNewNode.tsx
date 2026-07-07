import { CODE_NEW_OUTPUT_PORT_ID, type CodeNewNode, type Inputs } from '@valerypopoff/rivet2-core';
import { type FC, useMemo } from 'react';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { tryRestoreStoredPortMap } from '../../utils/executionDataReaders.js';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import {
  getCodeNewParsedSource,
  getCodeNewPreviewSource,
  hasCodeNewInterpolationInputs,
} from './codeNewOutputUtils.js';
import { getCodeNodeErrorViewModel } from './codeNodeOutputUtils.js';
import { shouldShowStructuredOutputDetails } from './parsedSourceDisplayUtils.js';
import { StructuredNodeOutput, StructuredNodeOutputSection } from './StructuredNodeOutput.js';
import { getSortedRenderableSplitOutputEntries } from '../nodeOutput/splitOutputEntries.js';

const CodeNewNodeOutputBody: FC<{
  node: CodeNewNode;
  data: NodeRunDataWithRefs;
  renderMode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ node, data, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const hasError = data.status?.type === 'error';
  const parsedError = hasError ? getCodeNodeErrorViewModel(data) : undefined;
  const dataRefs = useDataRefs();
  const codeSource = getCodeNewPreviewSource(node, data);
  const isCompactPreview = renderMode === 'compact';
  const showStructuredDetails = shouldShowStructuredOutputDetails(renderMode);
  const shouldShowParsedCode = showStructuredDetails && hasCodeNewInterpolationInputs(codeSource);
  const splitOutputEntries = getSortedRenderableSplitOutputEntries(data.splitOutputData);
  const hasSplitOutputs = splitOutputEntries.length > 0;
  const parsedCode = useMemo(
    () =>
      shouldShowParsedCode
        ? getCodeNewParsedSource(
            node,
            data,
            (tryRestoreStoredPortMap(data.inputData, dataRefs) as Inputs | undefined) ?? {},
          )
        : undefined,
    [data, dataRefs, node, shouldShowParsedCode],
  );
  const renderValue = (outputs: NodeRunDataWithRefs['outputData']) => {
    const outputValue = outputs?.[CODE_NEW_OUTPUT_PORT_ID];
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
      <StructuredNodeOutputSection label="Returned value" key={key} statsValue={outputs?.[CODE_NEW_OUTPUT_PORT_ID]}>
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
      errorMessage={parsedError?.message}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
      parsedSource={shouldShowParsedCode ? parsedCode ?? '' : undefined}
      parsedSourceLabel="Parsed code"
      parsedSourceLanguage="javascript"
    >
      {showStructuredDetails && parsedError?.location && (
        <StructuredNodeOutputSection label="Error location">
          <div>
            line {parsedError.location.line}
            {parsedError.location.column != null ? `, column ${parsedError.location.column}` : ''}
          </div>
        </StructuredNodeOutputSection>
      )}
      {hasSplitOutputs && (
        <div className="split-output">{splitOutputEntries.map(([key, outputs]) => renderResult(outputs, key))}</div>
      )}
      {!hasSplitOutputs && renderResult(data.outputData)}
    </StructuredNodeOutput>
  );
};

export const codeNewNodeDescriptor: NodeComponentDescriptor<'codeNew'> = {
  Output: ({ node, data, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <CodeNewNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <CodeNewNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};
