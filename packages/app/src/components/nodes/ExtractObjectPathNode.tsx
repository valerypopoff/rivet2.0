import { type ExtractObjectPathNode, type Inputs, type PortId } from '@valerypopoff/rivet2-core';
import { type FC, useMemo } from 'react';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { tryRestoreStoredPortMap } from '../../utils/executionDataReaders.js';
import {
  getExtractObjectPathPreviewSource,
  getExtractObjectPathUsePathInput,
  getParsedExtractObjectPathPreviewSource,
  hasExtractObjectPathInterpolationInputs,
} from './extractObjectPathOutputUtils.js';
import { StructuredNodeOutput, StructuredNodeOutputSection } from './StructuredNodeOutput.js';
import { getSortedRenderableSplitOutputEntries } from '../nodeOutput/splitOutputEntries.js';

const outputDefinitions = [
  { id: 'match' as PortId, label: 'Match' },
  { id: 'all_matches' as PortId, label: 'All Matches' },
];

const ExtractObjectPathNodeOutputBody: FC<{
  node: ExtractObjectPathNode;
  data: NodeRunDataWithRefs;
  renderMode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ node, data, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const errorMessage = data.status?.type === 'error' ? data.status.error : undefined;
  const hasError = data.status?.type === 'error';
  const dataRefs = useDataRefs();
  const pathSource = getExtractObjectPathPreviewSource(node, data);
  const shouldShowParsedExpression =
    !getExtractObjectPathUsePathInput(node, data) && hasExtractObjectPathInterpolationInputs(pathSource);
  const splitOutputEntries = getSortedRenderableSplitOutputEntries(data.splitOutputData);
  const hasSplitOutputs = splitOutputEntries.length > 0;
  const parsedExpression = useMemo(
    () =>
      shouldShowParsedExpression
        ? getParsedExtractObjectPathPreviewSource(
            pathSource,
            (tryRestoreStoredPortMap(data.inputData, dataRefs) as Inputs | undefined) ?? {},
          )
        : undefined,
    [data.inputData, dataRefs, pathSource, shouldShowParsedExpression],
  );

  const renderOutputs = (outputs: NodeRunDataWithRefs['outputData'], keyPrefix = '') =>
    outputDefinitions.flatMap(({ id, label }) => {
      const outputValue = outputs?.[id];
      if (outputValue == null) {
        return [];
      }

      return [
        <StructuredNodeOutputSection label={label} key={`${keyPrefix}${id}`}>
          <RenderDataValue
            value={outputValue}
            mode={renderMode}
            allowLargeStoredValueActions={allowLargeStoredValueActions}
            wrapLines={wrapLines}
          />
        </StructuredNodeOutputSection>,
      ];
    });

  return (
    <StructuredNodeOutput
      errorMessage={errorMessage}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
      parsedSource={shouldShowParsedExpression ? parsedExpression ?? '' : undefined}
      parsedSourceLanguage="jsonpath"
    >
      {!hasError && hasSplitOutputs && (
        <div className="split-output">
          {splitOutputEntries.map(([key, outputs]) => renderOutputs(outputs, `${key}:`))}
        </div>
      )}

      {!hasError && !hasSplitOutputs && renderOutputs(data.outputData)}
    </StructuredNodeOutput>
  );
};

export const extractObjectPathNodeDescriptor: NodeComponentDescriptor<'extractObjectPath'> = {
  Output: ({ node, data, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <ExtractObjectPathNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <ExtractObjectPathNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};
