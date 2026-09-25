import Checkbox from '@atlaskit/checkbox';
import { Field, HelperMessage } from '@atlaskit/form';
import Portal from '@atlaskit/portal';
import Select from '@atlaskit/select';
import { css } from '@emotion/react';
import {
  scalarTypes,
  type DataTypeSelectorEditorDefinition,
  type ChartNode,
  type DataType,
  type GetGlobalNodeData,
  type ScalarDataType,
  getScalarTypeOf,
  isArrayDataType,
  dataTypeDisplayNames,
} from '@valerypopoff/rivet2-core';
import { useState, type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';

const validSelectableDataTypes = scalarTypes.filter((type) => type !== 'control-flow-excluded');

export const DefaultDataTypeSelector: FC<
  SharedEditorProps & {
    editor: DataTypeSelectorEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const dataType = data[editor.dataKey] as DataType | undefined;
  const helperMessage = getHelperMessage(editor, node.data);
  const suggested = data.typeSuggestion as GetGlobalNodeData['typeSuggestion'];
  const notice =
    node.type === 'getGlobal' &&
    !data.useIdInput &&
    suggested &&
    data.id === suggested.id &&
    dataType === suggested.type
      ? suggested
      : undefined;
  const conflictText = notice?.conflictingTypes.map((type) => dataTypeDisplayNames[type]).join(', ');

  return (
    <DataTypeSelector
      value={dataType}
      allowedDataTypes={editor.allowedDataTypes}
      onChange={(newValue) => {
        const nextData: Record<string, unknown> = { ...data, [editor.dataKey]: newValue };
        if (node.type === 'getGlobal') delete nextData.typeSuggestion;
        onChange({
          ...node,
          data: nextData,
        });
      }}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      helperMessage={helperMessage}
      afterControlMessage={
        notice
          ? {
              text: `Data type set to ${dataTypeDisplayNames[notice.type]} from variable "${notice.id}" (${notice.source}).${conflictText ? ` Other declarations use ${conflictText}.` : ''}`,
              warning: Boolean(conflictText),
            }
          : undefined
      }
    />
  );
};

export const DataTypeSelector: FC<{
  value: DataType | undefined;
  allowedDataTypes?: ScalarDataType[];
  onChange: (value: DataType | undefined) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  helperMessage?: string;
  afterControlMessage?: { text: string; warning: boolean };
  menuPortal?: boolean;
}> = ({ value, allowedDataTypes, onChange, isReadonly, isDisabled, helperMessage, afterControlMessage, menuPortal = true }) => {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const scalarType = value ? getScalarTypeOf(value) : undefined;
  const isArray = value ? isArrayDataType(value) : undefined;

  const selectableDataTypes = allowedDataTypes ?? validSelectableDataTypes;
  const dataTypeOptions = selectableDataTypes.map((type) => ({
    label: dataTypeDisplayNames[type],
    value: type,
  }));

  const selectedOption = dataTypeOptions.find((option) => option.value === scalarType);

  return (
    <div
      className="data-type-selector"
      css={css`
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        column-gap: var(--node-editor-side-control-gap, 16px);
      `}
    >
      <Field name="data-type" label="Data Type" isDisabled={isReadonly || isDisabled}>
        {({ fieldProps }) => (
          <>
            {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
            <Select
              {...fieldProps}
              isDisabled={isReadonly || isDisabled}
              menuPlacement="auto"
              menuPortalTarget={menuPortal ? (menuPortalTarget ?? undefined) : undefined}
              menuPosition="fixed"
              menuShouldScrollIntoView={false}
              options={dataTypeOptions}
              value={selectedOption}
              onChange={(selected) => {
                if (isReadonly || isDisabled) return;
                onChange(selected ? (isArray ? (`${selected.value}[]` as DataType) : selected.value) : undefined);
              }}
            />
            {menuPortal && (
              <Portal zIndex={1000}>
                <div ref={setMenuPortalTarget} />
              </Portal>
            )}
          </>
        )}
      </Field>
      <Field label=" " name="is-array" isDisabled={isReadonly}>
        {({ fieldProps }) => (
          <Checkbox
            {...fieldProps}
            isChecked={isArray}
            label="Array"
            css={css`
              margin-top: 16px;
            `}
            onChange={(e) => {
              if (isReadonly || isDisabled || !scalarType) return;
              onChange(e.target.checked ? (`${scalarType}[]` as DataType) : scalarType);
            }}
            isDisabled={isReadonly || isDisabled || !scalarType}
          />
        )}
      </Field>
      {afterControlMessage && (
        <div
          role="status"
          css={css`
            grid-column: 1 / -1;
            margin-top: 4px;
            color: ${afterControlMessage.warning ? 'var(--warning)' : 'var(--foreground-muted)'};
            font-size: var(--ui-font-size-sm);
          `}
        >
          {afterControlMessage.text}
        </div>
      )}
    </div>
  );
};
