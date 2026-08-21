import { type FC } from 'react';
import { type PortId } from '@valerypopoff/rivet2-core';
import { RenderDataValue, type OutputRenderMode } from '../RenderDataValue.js';
import { type NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { type InputsOrOutputsWithRefs } from '../../state/dataFlow';
import { getLoopControllerNodeCopyValueData } from '../../utils/nodeOutputCopyValueProjectors.js';

export const LoopControllerNodeOutput: FC<{
  outputs: InputsOrOutputsWithRefs;
  renderMarkdown?: boolean;
  isCompact: boolean;
  renderMode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ outputs, renderMarkdown, isCompact, renderMode, allowLargeStoredValueActions, wrapLines }) => {
  const outputKeys = Object.keys(outputs).filter((key) => key.startsWith('output') && outputs[key as PortId] != null);

  const breakLoop = outputs['break' as PortId] != null && outputs['break' as PortId]!.type !== 'control-flow-excluded';

  return (
    <div>
      <div key="break">
        <em>Continue:</em>
        {breakLoop ? 'false' : 'true'}
      </div>
      {outputKeys.map((key, i) => (
        <div key={key}>
          <div>
            <em>Output {i + 1}</em>
          </div>
          <RenderDataValue
            key={key}
            value={outputs[key as PortId]}
            isCompact={isCompact}
            renderMarkdown={renderMarkdown}
            mode={renderMode}
            allowLargeStoredValueActions={allowLargeStoredValueActions}
            wrapLines={wrapLines}
          />
        </div>
      ))}
    </div>
  );
};

export const loopControllerNodeDescriptor: NodeComponentDescriptor<'loopController'> = {
  OutputSimple: LoopControllerNodeOutput,
  getCopyValueData: getLoopControllerNodeCopyValueData,
};
