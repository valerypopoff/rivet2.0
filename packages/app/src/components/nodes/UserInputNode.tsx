import { type FC } from 'react';
import { css } from '@emotion/react';
import { type PortId, getScalarTypeOf } from '@valerypopoff/rivet2-core';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { type InputsOrOutputsWithRefs } from '../../state/dataFlow';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { getUserInputNodeCopyValueData } from '../../utils/nodeOutputCopyValueProjectors.js';

const questionsAndAnswersStyles = css`
  display: flex;
  flex-direction: column;
  gap: 8px;

  pre {
    white-space: pre-wrap;
  }
`;

export const UserInputNodeOutput: FC<{
  outputs: InputsOrOutputsWithRefs;
  isCompact: boolean;
  renderMarkdown?: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, isCompact, renderMarkdown, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const questionsAndAnswers = outputs['questionsAndAnswers' as PortId];

  if (!questionsAndAnswers || getScalarTypeOf(questionsAndAnswers.type) === 'control-flow-excluded') {
    return null;
  }

  return (
    <div css={questionsAndAnswersStyles}>
      <RenderDataValue
        value={questionsAndAnswers}
        isCompact={isCompact}
        renderMarkdown={renderMarkdown}
        mode={renderMode}
        allowLargeStoredValueActions={allowLargeStoredValueActions}
        wrapLines={wrapLines}
      />
    </div>
  );
};

export const userInputNodeDescriptor: NodeComponentDescriptor<'userInput'> = {
  OutputSimple: UserInputNodeOutput,
  getCopyValueData: getUserInputNodeCopyValueData,
};
