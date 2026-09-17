import { css } from '@emotion/react';
import type { AssemblePromptNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';

const styles = css`
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-xs);
  line-height: 1.4;

  .assemble-prompt-node-body-label {
    opacity: 0.6;
  }
`;

const AssemblePromptNodeBody: FC<{ node: AssemblePromptNode }> = ({ node }) => (
  <div css={styles}>
    {node.data.filterEmptyPrompts ? (
      <div>
        <span className="assemble-prompt-node-body-label">Filter empty prompts:</span> Enabled
      </div>
    ) : null}
    {node.data.useIsLastMessageCacheBreakpointInput ? (
      <div>Last message cache breakpoint: From input</div>
    ) : node.data.isLastMessageCacheBreakpoint ? (
      <div>Last message is cache breakpoint</div>
    ) : null}
  </div>
);

export const assemblePromptNodeDescriptor: NodeComponentDescriptor<'assemblePrompt'> = {
  Body: AssemblePromptNodeBody,
};
