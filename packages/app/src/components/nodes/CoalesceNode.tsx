import { css } from '@emotion/react';
import type { CoalesceNewNode, CoalesceNode } from '@valerypopoff/rivet2-core';
import type { ChangeEvent, FC, MouseEvent } from 'react';
import { useId } from 'react';
import { useEditNodeCommand } from '../../commands/editNodeCommand.js';
import type { NodeComponentDescriptor } from '../../hooks/useNodeTypes.js';
import { ScalableToggle } from '../ScalableToggle.js';

type CoalesceToggleKey = 'ignoreNull' | 'ignoreUndefined';

const coalesceBodyToggles: Array<{
  ariaLabel: string;
  dataKey: CoalesceToggleKey;
  label: string;
}> = [
  {
    ariaLabel: "Ignore 'null'",
    dataKey: 'ignoreNull',
    label: 'Ignore null',
  },
  {
    ariaLabel: "Ignore 'undefined'",
    dataKey: 'ignoreUndefined',
    label: 'Ignore undefined',
  },
];

const styles = css`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: calc(9px * var(--ui-font-scale, 1));
  max-width: 100%;
  min-width: 0;
  color: var(--foreground-bright);
  font-family: var(--font-family-monospace);
  font-size: var(--ui-font-size-xs);
  line-height: 1.2;
  user-select: none;

  .coalesce-node-body-row {
    display: flex;
    align-items: center;
    max-width: 100%;
    min-width: 0;
  }

  .coalesce-node-body-toggle-wrap {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    line-height: 0;
  }

  .coalesce-node-body-toggle {
    width: calc(32px * var(--ui-font-scale, 1));
    height: calc(16px * var(--ui-font-scale, 1));
    aspect-ratio: 2 / 1;
    line-height: 0;
  }

  .coalesce-node-body-label {
    font-family: inherit !important;
    font-size: inherit !important;
    padding-left: calc(7px * var(--ui-font-scale, 1));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
`;

const CoalesceNodeBody = ({ node }: { node: CoalesceNode | CoalesceNewNode }) => {
  const editNode = useEditNodeCommand();
  const toggleIdBase = useId();

  const handleChange = (dataKey: CoalesceToggleKey) => (event: ChangeEvent<HTMLInputElement>) => {
    editNode({
      nodeId: node.id,
      newNode: {
        data: {
          ...node.data,
          [dataKey]: event.target.checked,
        },
      },
    });
  };

  const handleToggleDoubleClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  return (
    <div css={styles}>
      {coalesceBodyToggles.map((toggle) => {
        const toggleInputId = `${toggleIdBase}-${toggle.dataKey}`;

        return (
          <div className="coalesce-node-body-row" key={toggle.dataKey}>
            <span className="coalesce-node-body-toggle-wrap" onDoubleClick={handleToggleDoubleClick}>
              <ScalableToggle
                ariaLabel={toggle.ariaLabel}
                className={`coalesce-node-body-toggle coalesce-node-body-toggle-${toggle.dataKey}`}
                id={toggleInputId}
                isChecked={node.data[toggle.dataKey] === true}
                onChange={handleChange(toggle.dataKey)}
              />
            </span>
            <label
              className="coalesce-node-body-label"
              htmlFor={toggleInputId}
              onDoubleClick={handleToggleDoubleClick}
            >
              {toggle.label}
            </label>
          </div>
        );
      })}
    </div>
  );
};

const LegacyCoalesceNodeBody: FC<{ node: CoalesceNode }> = ({ node }) => <CoalesceNodeBody node={node} />;

const CurrentCoalesceNodeBody: FC<{ node: CoalesceNewNode }> = ({ node }) => <CoalesceNodeBody node={node} />;

export const coalesceNodeDescriptor: NodeComponentDescriptor<'coalesce'> = {
  Body: LegacyCoalesceNodeBody,
};

export const coalesceNewNodeDescriptor: NodeComponentDescriptor<'coalesceNew'> = {
  Body: CurrentCoalesceNodeBody,
};
