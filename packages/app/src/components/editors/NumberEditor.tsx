import { Field, HelperMessage } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { type ChartNode, type NumberEditorDefinition } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';

export const DefaultNumberEditor: FC<
  SharedEditorProps & {
    editor: NumberEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor, onClose }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);
  return (
    <NumberEditor
      value={data[editor.dataKey] as number | undefined}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      autoFocus={editor.autoFocus}
      onChange={(newValue) => {
        onChange({
          ...node,
          data: {
            ...data,
            [editor.dataKey]: newValue,
          },
        });
      }}
      label={editor.label}
      name={editor.dataKey}
      helperMessage={helperMessage}
      onClose={onClose}
      min={editor.min}
      max={editor.max}
      step={editor.step}
      allowEmpty={editor.allowEmpty}
      defaultValue={editor.defaultValue}
      storageMultiplier={editor.storageMultiplier}
    />
  );
};

export const NumberEditor: FC<{
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  autoFocus?: boolean;
  label: string;
  name?: string;
  helperMessage?: string;
  onClose?: () => void;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
  defaultValue?: number;
  /** Converts a displayed editor value back to the value stored on the node. */
  storageMultiplier?: number;
}> = ({
  value,
  onChange,
  isReadonly,
  isDisabled,
  label,
  name,
  autoFocus,
  helperMessage,
  onClose,
  min,
  max,
  step,
  allowEmpty,
  defaultValue,
  storageMultiplier = 1,
}) => {
  const toDisplayValue = (storedValue: number | undefined): number | undefined =>
    storedValue == null ? undefined : storedValue / storageMultiplier;
  const toStoredValue = (displayValue: number): number => Math.round(displayValue * storageMultiplier);

  return (
    <Field name={name ?? label} label={label} isDisabled={isDisabled}>
      {({ fieldProps }) => (
        <>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <TextField
            {...fieldProps}
            type="number"
            min={toDisplayValue(min)}
            max={toDisplayValue(max)}
            step={toDisplayValue(step)}
            defaultValue={toDisplayValue(value ?? defaultValue)}
            isReadOnly={isReadonly}
            autoFocus={autoFocus}
            onChange={(e) => {
              if (allowEmpty && (e.target as HTMLInputElement).value === '') {
                onChange(undefined);
              } else {
                onChange(toStoredValue((e.target as HTMLInputElement).valueAsNumber));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onClose?.();
              }
            }}
          />
        </>
      )}
    </Field>
  );
};
