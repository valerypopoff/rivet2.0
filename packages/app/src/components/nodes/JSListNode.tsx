import { type Inputs, type JSFilterNode, type JSMapNode, type PortId } from '@valerypopoff/rivet2-core';
import { type FC, useMemo } from 'react';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { type NodeRunDataWithRefs } from '../../state/dataFlow.js';
import { tryRestoreStoredPortMap } from '../../utils/executionDataReaders.js';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import {
  getJSListCallbackPreviewSource,
  getParsedJSListCallbackPreviewSource,
  hasJSListCallbackInterpolationInputs,
} from './jsListOutputUtils.js';
import { StructuredNodeOutput, StructuredNodeOutputSection } from './StructuredNodeOutput.js';
import { getSortedRenderableSplitOutputEntries } from '../nodeOutput/splitOutputEntries.js';

type JSListNode = JSFilterNode | JSMapNode;

const JS_LIST_OUTPUT_CONFIG = {
  jsFilter: { outputId: 'filtered' as PortId, resultLabel: 'Filtered' },
  jsMap: { outputId: 'mapped' as PortId, resultLabel: 'Mapped' },
};

const JSListNodeOutputBody: FC<{
  node: JSListNode;
  data: NodeRunDataWithRefs;
  renderMode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ node, data, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const { outputId, resultLabel } = JS_LIST_OUTPUT_CONFIG[node.type];
  const errorMessage = data.status?.type === 'error' ? data.status.error : undefined;
  const hasError = data.status?.type === 'error';
  const dataRefs = useDataRefs();
  const callbackBodySource = getJSListCallbackPreviewSource(node, data);
  const shouldShowParsedExpression = hasJSListCallbackInterpolationInputs(callbackBodySource);
  const splitOutputEntries = getSortedRenderableSplitOutputEntries(data.splitOutputData);
  const hasSplitOutputs = splitOutputEntries.length > 0;
  const parsedExpression = useMemo(
    () =>
      shouldShowParsedExpression
        ? getParsedJSListCallbackPreviewSource(
            callbackBodySource,
            (tryRestoreStoredPortMap(data.inputData, dataRefs) as Inputs | undefined) ?? {},
          )
        : undefined,
    [callbackBodySource, data.inputData, dataRefs, shouldShowParsedExpression],
  );

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
        <div className="split-output">
          {splitOutputEntries
            .filter(([, outputs]) => outputs[outputId] != null)
            .map(([key, outputs]) => (
              <StructuredNodeOutputSection label={resultLabel} key={key} statsValue={outputs[outputId]}>
                <RenderDataValue
                  value={outputs[outputId]}
                  mode={renderMode}
                  allowLargeStoredValueActions={allowLargeStoredValueActions}
                  wrapLines={wrapLines}
                />
              </StructuredNodeOutputSection>
            ))}
        </div>
      )}

      {!hasError && !hasSplitOutputs && data.outputData?.[outputId] != null && (
        <StructuredNodeOutputSection label={resultLabel} statsValue={data.outputData?.[outputId]}>
          <RenderDataValue
            value={data.outputData?.[outputId]}
            mode={renderMode}
            allowLargeStoredValueActions={allowLargeStoredValueActions}
            wrapLines={wrapLines}
          />
        </StructuredNodeOutputSection>
      )}
    </StructuredNodeOutput>
  );
};

export const jsFilterNodeDescriptor: NodeComponentDescriptor<'jsFilter'> = {
  Output: ({ node, data, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <JSListNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <JSListNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};

export const jsMapNodeDescriptor: NodeComponentDescriptor<'jsMap'> = {
  Output: ({ node, data, renderMode = 'compact', allowLargeStoredValueActions, wrapLines }) => (
    <JSListNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
  FullscreenOutput: ({ node, data, renderMode = 'expanded-preview', allowLargeStoredValueActions, wrapLines }) => (
    <JSListNodeOutputBody
      node={node}
      data={data}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  ),
};
