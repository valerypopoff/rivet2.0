import { type FC } from 'react';
import { css } from '@emotion/react';
import { RenderDataValue } from '../RenderDataValue.js';
import {
  type DataValue,
  type PortId,
  coerceTypeOptional,
  inferType,
  isArrayDataValue,
} from '@valerypopoff/rivet2-core';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import styled from '@emotion/styled';
import clsx from 'clsx';
import { type DataValueWithRefs, type InputsOrOutputsWithRefs } from '../../state/dataFlow';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import { tryRestoreStoredDataValue } from '../../utils/executionDataStorage.js';
import type { OutputRenderMode } from '../RenderDataValue.js';
import { getChatNodeCopyValueData } from '../../utils/nodeOutputCopyValueProjectors.js';
import { OUTPUT_NAVIGATION_ITEM_ATTRIBUTE } from '../renderDataValue/outputNavigationItems.js';

const bodyStyles = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;

  &.multi-message {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
`;

export const ChatNodeOutput: FC<{
  outputs: InputsOrOutputsWithRefs;
  fullscreen?: boolean;
  renderMarkdown?: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, fullscreen, renderMarkdown, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const dataRefs = useDataRefs();
  const responseValue = tryRestoreStoredDataValue(outputs['response' as PortId], dataRefs);
  const requestTokensValue = tryRestoreStoredDataValue(outputs['requestTokens' as PortId], dataRefs);
  const responseTokensValue = tryRestoreStoredDataValue(outputs['responseTokens' as PortId], dataRefs);
  const costValue = tryRestoreStoredDataValue(outputs['cost' as PortId], dataRefs);
  const durationValue = tryRestoreStoredDataValue(outputs['duration' as PortId], dataRefs);
  const functionCallValue =
    tryRestoreStoredDataValue(outputs['function-call' as PortId], dataRefs) ??
    tryRestoreStoredDataValue(outputs['function-calls' as PortId], dataRefs);

  if (isArrayDataValue(responseValue) || isArrayDataValue(requestTokensValue)) {
    const outputTextAll = coerceTypeOptional(responseValue, 'string[]') ?? [];

    const requestTokensAll = coerceTypeOptional(requestTokensValue, 'number[]') ?? [];
    const responseTokensAll = coerceTypeOptional(responseTokensValue, 'number[]') ?? [];
    const costAll = coerceTypeOptional(costValue, 'number[]') ?? [];
    const durationAll = coerceTypeOptional(durationValue, 'number[]') ?? [];

    const functionCallAll =
      functionCallValue?.type === 'object[]'
        ? functionCallValue.value
        : coerceTypeOptional(functionCallValue, 'string[]');

    return (
      <div className="multi-message" css={bodyStyles}>
        {outputTextAll.map((outputText, index) => {
          const requestTokens = requestTokensAll?.[index];
          const responseTokens = responseTokensAll?.[index];
          const cost = costAll?.[index];
          const duration = durationAll?.[index];
          const functionCall = functionCallAll?.[index];

          return (
            <ChatNodeOutputSingle
              key={index}
              outputValue={outputText == null ? undefined : { type: 'string', value: outputText }}
              isResponseItem
              requestTokens={requestTokens}
              responseTokens={responseTokens}
              cost={cost}
              duration={duration}
              functionCallValue={functionCall == null ? undefined : inferType(functionCall)}
              fullscreen={fullscreen}
              renderMarkdown={renderMarkdown}
              renderMode={renderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          );
        })}
      </div>
    );
  } else {
    const outputText = coerceTypeOptional(responseValue, 'string');

    const requestTokens = coerceTypeOptional(requestTokensValue, 'number');
    const responseTokens = coerceTypeOptional(responseTokensValue, 'number');
    const cost = coerceTypeOptional(costValue, 'number');
    const duration = coerceTypeOptional(durationValue, 'number');

    return (
      <ChatNodeOutputSingle
        outputValue={outputs['response' as PortId]}
        isResponseItem={false}
        requestTokens={requestTokens}
        responseTokens={responseTokens}
        cost={cost}
        functionCallValue={functionCallValue}
        duration={duration}
        fullscreen={fullscreen}
        renderMarkdown={renderMarkdown}
        renderMode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    );
  }
};

const ChatNodeOutputContainer = styled.div`
  position: relative;

  .function-call h4 {
    margin-top: 0;
    margin-bottom: 0;
    text-decoration: none;
    font-size: var(--ui-font-size-sm);
    font-weight: normal;
    color: var(--primary-text);
  }

  .metaInfo {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    min-height: 40px;
    color: var(--grey-lighter);
  }

  &.fullscreen .metaInfo {
    padding: 10px;
    border-bottom: 1px solid var(--grey-darkish);
  }

  &.fullscreen .outputText {
    padding: 10px;
  }
`;

export const ChatNodeOutputSingle: FC<{
  outputValue: DataValueWithRefs | DataValue | undefined;
  isResponseItem: boolean;
  functionCallValue: DataValue | undefined;
  requestTokens: number | undefined;
  responseTokens: number | undefined;
  cost: number | undefined;
  duration: number | undefined;
  fullscreen?: boolean;
  renderMarkdown?: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({
  outputValue,
  isResponseItem,
  functionCallValue,
  requestTokens,
  responseTokens,
  cost,
  duration,
  fullscreen,
  renderMarkdown,
  renderMode,
  allowLargeStoredValueActions,
  wrapLines,
}) => {
  const effectiveRenderMode = renderMode ?? (fullscreen ? 'expanded-preview' : 'compact');

  return (
    <ChatNodeOutputContainer
      className={clsx({ fullscreen })}
      {...(isResponseItem ? { [OUTPUT_NAVIGATION_ITEM_ATTRIBUTE]: '' } : undefined)}
    >
      <div className="metaInfo">
        {(responseTokens != null || requestTokens != null || cost != null) && (
          <div style={{ marginBottom: 8 }}>
            {(requestTokens ?? 0) > 0 && (
              <div>
                <em>Request Tokens: {requestTokens}</em>
              </div>
            )}
            {(responseTokens ?? 0) > 0 && (
              <div>
                <em>Response Tokens: {responseTokens}</em>
              </div>
            )}
            {(cost ?? 0) > 0 && (
              <div>
                <em>${cost!.toFixed(3)}</em>
              </div>
            )}
            {(duration ?? 0) > 0 && (
              <div>
                <em>Duration: {duration}ms</em>
              </div>
            )}
          </div>
        )}
      </div>

      {outputValue != null && (
        <div className={clsx('outputText', { markdown: renderMarkdown })}>
          <div className={clsx({ 'pre-wrap': !renderMarkdown })}>
            <RenderDataValue
              value={outputValue}
              renderMarkdown={renderMarkdown}
              mode={effectiveRenderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          </div>
        </div>
      )}
      {hasRenderableFunctionCallValue(functionCallValue) && (
        <div className="function-call">
          <h4>{Array.isArray(functionCallValue.value) ? 'Function Calls' : 'Function Call'}:</h4>
          <div className="pre-wrap">
            <RenderDataValue
              value={functionCallValue}
              mode={effectiveRenderMode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          </div>
        </div>
      )}
    </ChatNodeOutputContainer>
  );
};

function hasRenderableFunctionCallValue(value: DataValue | undefined): value is DataValue {
  if (!value) {
    return false;
  }

  return !Array.isArray(value.value) || value.value.length > 0;
}

const ChatNodeFullscreenOutput: FC<{
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, renderMarkdown, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  return (
    <ChatNodeOutput
      outputs={outputs}
      fullscreen
      renderMarkdown={renderMarkdown}
      renderMode={renderMode}
      allowLargeStoredValueActions={allowLargeStoredValueActions}
      wrapLines={wrapLines}
    />
  );
};

export const chatNodeDescriptor: NodeComponentDescriptor<'chat'> = {
  OutputSimple: ChatNodeOutput,
  FullscreenOutputSimple: ChatNodeFullscreenOutput,
  getCopyValueData: getChatNodeCopyValueData,
  defaultRenderMarkdown: true,
};
