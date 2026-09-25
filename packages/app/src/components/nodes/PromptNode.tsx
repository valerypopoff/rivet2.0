import { css } from '@emotion/react';
import { buildNodeBodyPreview, type PromptNode, type PromptNodeData } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { ColorizedNodeBody } from '../ColorizedNodeBody.js';

const styles = css`
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;

  .prompt-node-role {
    font-style: italic;
    line-height: 1.4;
  }

  .prompt-node-text .node-body-colorized-wrap {
    line-height: 1.4;
    margin: 0;
    max-width: 100%;
    min-width: 0;
    overflow-wrap: normal;
    white-space: pre-wrap;
    width: 100%;
    word-break: normal;
  }
`;

const typeDisplay: Record<PromptNodeData['type'], string> = {
  assistant: 'Assistant',
  developer: 'Developer',
  system: 'System',
  user: 'User',
  function: 'Function',
};

const PromptNodeBody: FC<{ node: PromptNode }> = ({ node }) => {
  const role = `${typeDisplay[node.data.type]}${node.data.name ? ` (${node.data.name})` : ''}`;
  const promptText = buildNodeBodyPreview(node.data.promptText);

  return (
    <div css={styles}>
      <div className="prompt-node-role">
        <em>{role}</em>
        {node.data.isCacheBreakpoint ? ' (Cache Breakpoint)' : ''}
      </div>
      <div className="prompt-node-text">
        <ColorizedNodeBody
          language="prompt-interpolation-markdown"
          text={promptText}
          theme="prompt-interpolation"
          type="colorized"
        />
      </div>
    </div>
  );
};

export const promptNodeDescriptor: NodeComponentDescriptor<'prompt'> = {
  Body: PromptNodeBody,
};
