import { css } from '@emotion/react';
import { getToolNodeBodyPreview, type GptFunctionNode } from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { ColorizedNodeBody } from '../ColorizedNodeBody.js';

const toolNodeBodyStyles = css`
  display: flex;
  flex-direction: column;
  font-family: var(--font-family-monospace);
  font-size: calc(12px * var(--ui-font-scale, 1));
  max-width: 100%;
  min-width: 0;
  overflow: hidden;

  .tool-node-body-name {
    line-height: 1.4;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .tool-node-body-name-label {
    opacity: 0.6;
  }

  .tool-node-body-description {
    border-top: 1px solid color-mix(in srgb, var(--foreground) 12%, transparent);
    margin-top: 8px;
    min-width: 0;
    padding-top: 8px;
  }

  .tool-node-body-description .node-body-colorized-wrap {
    margin: 0;
    max-width: 100%;
    min-width: 0;
    overflow-wrap: normal;
    white-space: pre-wrap;
    width: 100%;
    word-break: normal;
  }
`;

const ToolNodeBody: FC<{ node: GptFunctionNode }> = ({ node }) => {
  const preview = getToolNodeBodyPreview(node.data);

  return (
    <div css={toolNodeBodyStyles}>
      <div className="tool-node-body-name">
        <span className="tool-node-body-name-label">Name:</span> {preview.name}
      </div>
      {preview.description ? (
        <div className="tool-node-body-description">
          <ColorizedNodeBody
            language="prompt-interpolation-markdown"
            text={preview.description}
            theme="prompt-interpolation"
            type="colorized"
          />
        </div>
      ) : null}
    </div>
  );
};

export const toolNodeDescriptor: NodeComponentDescriptor<'gptFunction'> = {
  Body: ToolNodeBody,
};
