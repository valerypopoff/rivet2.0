import {
  arrayizeDataValue,
  dataTypes,
  functionTypeToReturnType,
  getScalarTypeOf,
  isArrayDataType,
  isFunctionDataType,
  type DataType,
  type FunctionDataType,
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

  const createRenderer = (dataType: string): FC<DataValueRendererProps> => {
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

      // An Any value can hold a heterogeneous JSON array. Do not infer the
      // whole array from its first element: [number[], number] would otherwise
      // be treated as number[][] and the scalar number would render as an
      // invalid array. Keep each item as Any so recursive rendering infers it
      // independently.
      const isAnyArray = dataType === 'any' && Array.isArray(value.value);
      if (isArrayDataType(dataType as DataType) || isAnyArray) {
        if (!Array.isArray(value.value)) {
          return (
            <div css={multiOutputStyles}>
              <div className="array-info">Invalid array value</div>
            </div>
          );
        }

        let items = isAnyArray
          ? value.value.map((item) => ({ type: 'any' as const, value: item }))
          : arrayizeDataValue(value as ScalarOrArrayDataValue);
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

      if (isFunctionDataType(dataType as DataType)) {
        const type = functionTypeToReturnType(dataType as FunctionDataType);
        return (
          <div>
            <em>Function{`<${type}>`}</em>
          </div>
        );
      }

      const ScalarRenderer = scalarRenderers[dataType as ScalarDataType] as FC<ScalarRendererProps<ScalarDataType>>;

      if (!ScalarRenderer) {
        return <div>ERROR: UNKNOWN TYPE: {dataType}</div>;
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

    return Renderer;
  };

  const rendererMap = Object.fromEntries(dataTypes.map((dataType) => [dataType, createRenderer(dataType)])) as Record<
    DataType,
    FC<DataValueRendererProps>
  >;
  const dynamicRenderers = new Map<string, FC<DataValueRendererProps>>();

  return {
    get(dataType: string): FC<DataValueRendererProps> {
      const registeredRenderer = rendererMap[dataType as DataType] as FC<DataValueRendererProps> | undefined;
      if (registeredRenderer) {
        return registeredRenderer;
      }

      let dynamicRenderer = dynamicRenderers.get(dataType);
      if (!dynamicRenderer) {
        dynamicRenderer = createRenderer(dataType);
        dynamicRenderers.set(dataType, dynamicRenderer);
      }
      return dynamicRenderer;
    },
  };
}
