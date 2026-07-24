import {
  arrayizeDataValue,
  dataTypes,
  functionTypeToReturnType,
  getScalarTypeOf,
  isArrayDataType,
  isFunctionDataType,
  type DataType,
  type ScalarDataType,
  type ScalarOrArrayDataValue,
  type DataValue,
} from '@valerypopoff/rivet2-core';
import React, { Fragment, type FC, type ReactElement } from 'react';
import { multiOutputStyles, renderDataValueStyles } from './renderDataValueStyles.js';
import { type createScalarRenderers, type ScalarRendererProps } from './createScalarRenderers.js';
import type { OutputRenderMode } from './outputRenderTypes.js';

export type DataValueRendererProps = {
  value: DataValue | undefined;
  depth?: number;
  renderMarkdown?: boolean;
  truncateLength?: number;
  isCompact?: boolean;
  mode?: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
};

export function createDataValueRendererMap(options: {
  renderValue: (props: DataValueRendererProps) => ReactElement;
  scalarRenderers: ReturnType<typeof createScalarRenderers>;
}) {
  const { renderValue, scalarRenderers } = options;

  const rendererMap = Object.fromEntries(
    dataTypes.map((dataType) => {
      const Renderer: FC<DataValueRendererProps> = ({
        value,
        depth,
        renderMarkdown,
        truncateLength,
        isCompact,
        mode,
        allowLargeStoredValueActions,
        wrapLines,
      }) => {
        if (!value) {
          return <Fragment>undefined</Fragment>;
        }

        if (isArrayDataType(dataType)) {
          if (!Array.isArray(value.value)) {
            return (
              <div css={multiOutputStyles}>
                <div className="array-info">Invalid array value</div>
              </div>
            );
          }

          let items = arrayizeDataValue(value as ScalarOrArrayDataValue);
          const count = items.length;

          if (isCompact) {
            items = items.slice(0, 1);
          }

          return (
            <div css={multiOutputStyles}>
              <div className="array-info">
                {count.toLocaleString()} item{count === 1 ? '' : 's'}
              </div>
              {items.map((item, index) => (
                <div className="multi-output-item" key={index}>
                  {renderValue({
                    value: item,
                    depth: (depth ?? 0) + 1,
                    renderMarkdown,
                    truncateLength,
                    isCompact,
                    mode,
                    allowLargeStoredValueActions,
                    wrapLines,
                  })}
                </div>
              ))}
            </div>
          );
        }

        if (isFunctionDataType(dataType)) {
          const type = functionTypeToReturnType(dataType);
          return (
            <div>
              <em>Function{`<${type}>`}</em>
            </div>
          );
        }

        const ScalarRenderer = scalarRenderers[dataType as ScalarDataType] as FC<ScalarRendererProps<ScalarDataType>>;

        if (!ScalarRenderer) {
          return <div>ERROR: UNKNOWN TYPE: {JSON.stringify(value)}</div>;
        }

        return (
          <div css={renderDataValueStyles}>
            <ScalarRenderer
              value={value as Extract<DataValue, { type: ScalarDataType }>}
              depth={(depth ?? 0) + 1}
              renderMarkdown={renderMarkdown}
              truncateLength={truncateLength}
              isCompact={isCompact}
              mode={mode}
              allowLargeStoredValueActions={allowLargeStoredValueActions}
              wrapLines={wrapLines}
            />
          </div>
        );
      };

      return [dataType, Renderer];
    }),
  ) as Record<DataType, FC<DataValueRendererProps>>;

  return rendererMap;
}
