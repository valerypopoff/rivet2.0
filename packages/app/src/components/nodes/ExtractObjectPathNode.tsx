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
  renderMarkdown?: boolean;
  renderMode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ node, data, renderMarkdown, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const errorMessage = data.status?.type === 'error' ? data.status.error : undefined;
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
        <StructuredNodeOutputSection label={label} key={`${keyPrefix}${id}`} statsValue={outputValue}>
          <RenderDataValue
            value={outputValue}
            renderMarkdown={renderMarkdown}
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
      {hasSplitOutputs && (
        <div className="split-output">
          {splitOutputEntries.map(([key, outputs]) => renderOutputs(outputs, `${key}:`))}
        </div>
      )}

      {!hasSplitOutputs && renderOutputs(data.outputData)}
    </StructuredNodeOutput>
  );
};

export const extractObjectPathNodeDescriptor: NodeComponentDescriptor<'extractObjectPath'> = {
  Output: ({ node, data, renderMarkdown, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <ExtractObjectPathNodeOutputBody
      node={node}
      data={data}
      renderMarkdown={renderMarkdown}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMarkdown, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <ExtractObjectPathNodeOutputBody
      node={node}
      data={data}
      renderMarkdown={renderMarkdown}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};
