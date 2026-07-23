import { css } from '@emotion/react';
import type { PassthroughNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { LabeledToggle } from '../LabeledToggle.js';

const editorStyles = css`
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--ui-font-scale, 1));
`;

const PassthroughNodeEditor: FC<{
  node: PassthroughNode;
  onChange?: (node: PassthroughNode) => void;
}> = ({ node, onChange }) => {
  const renderAsDataBus = node.data.renderAsDataBus === true;
  const hasIncompatibleExecutionMode = !!node.isConditional || !!node.isSplitRun;

  return (
    <div css={editorStyles}>
      <LabeledToggle
        id={`passthrough-data-bus-${node.id}`}
        isChecked={renderAsDataBus}
        isDisabled={!renderAsDataBus && hasIncompatibleExecutionMode}
        label="Render as data bus"
        helperMessage={
          hasIncompatibleExecutionMode
            ? renderAsDataBus
              ? 'Data-bus presentation is paused. Turn off Conditional node and Run per item, or turn off this setting.'
              : 'Turn off Conditional node and Run per item before enabling data-bus presentation.'
            : 'Pins this Passthrough to the top of the canvas. Its stored connections and runtime behavior stay unchanged.'
        }
        onChange={(nextRenderAsDataBus) => {
          const data = { ...node.data };

          if (nextRenderAsDataBus) {
            data.renderAsDataBus = true;
          } else {
            delete data.renderAsDataBus;
          }

          onChange?.({
            ...node,
            data,
          });
        }}
      />
    </div>
  );
};

export const passthroughNodeDescriptor: NodeComponentDescriptor<'passthrough'> = {
  Editor: PassthroughNodeEditor,
};
