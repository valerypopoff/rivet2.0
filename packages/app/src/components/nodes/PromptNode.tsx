import { css } from '@emotion/react';
import type { PromptNode, PromptNodeData } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';

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

  .prompt-node-text {
    max-width: 100%;
    min-width: 0;
    width: 100%;
  }

  .prompt-node-line {
    font-family: inherit;
    line-height: 1.4;
    max-width: 100%;
    min-height: 1.4em;
    min-width: 0;
    overflow: hidden;
    overflow-wrap: normal;
    white-space: pre-wrap;
    word-break: normal;
  }

  .prompt-node-variable {
    color: var(--primary-text);
  }
`;

const typeDisplay: Record<PromptNodeData['type'], string> = {
  assistant: 'Assistant',
  developer: 'Developer',
  system: 'System',
  user: 'User',
  function: 'Function',
};

const interpolationTokenPattern = /(\{\{[^{}\n]+\}\})/g;
const interpolationTokenOnlyPattern = /^\{\{[^{}\n]+\}\}$/;

function renderPromptLine(line: string) {
  return line.split(interpolationTokenPattern).map((part, index) =>
    interpolationTokenOnlyPattern.test(part) ? (
      <span key={index} className="prompt-node-variable">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

const PromptNodeBody: FC<{ node: PromptNode }> = ({ node }) => {
  const role = `${typeDisplay[node.data.type]}${node.data.name ? ` (${node.data.name})` : ''}`;
  const promptLines = node.data.promptText.split('\n').slice(0, 15);

  return (
    <div css={styles}>
      <div className="prompt-node-role">
        <em>{role}</em>
        {node.data.isCacheBreakpoint ? ' (Cache Breakpoint)' : ''}
      </div>
      <div className="prompt-node-text">
        {promptLines.map((line, index) => (
          <div key={index} className="prompt-node-line">
            {line ? renderPromptLine(line) : '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  );
};

export const promptNodeDescriptor: NodeComponentDescriptor<'prompt'> = {
  Body: PromptNodeBody,
};
