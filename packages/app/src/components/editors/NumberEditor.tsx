import { ErrorMessage, Field, HelperMessage } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { type ChartNode, type NumberEditorDefinition } from '@valerypopoff/rivet2-core';
import { type FC, useLayoutEffect, useRef, useState } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';
import { resolveNumberEditorChange } from './numberEditorValue';

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
    storedValue == null || !Number.isFinite(storedValue) ? undefined : storedValue / storageMultiplier;
  const displayValue = toDisplayValue(value ?? defaultValue);
  const [draft, setDraft] = useState(String(displayValue ?? ''));
  const [invalid, setInvalid] = useState(false);
  const pendingAcknowledgement = useRef<{ value: number | undefined } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingAcknowledgement.current;
    pendingAcknowledgement.current = null;
    // A typing acknowledgement must not canonicalize a still-edited "0.10"
    // into "0.1". External changes (including Undo/Redo) still replace the draft.
    if (pending && Object.is(pending.value, displayValue)) return;
    setDraft(String(displayValue ?? ''));
    setInvalid(false);
  }, [displayValue]);

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
            value={draft}
            isInvalid={invalid}
            isReadOnly={isReadonly}
            autoFocus={autoFocus}
            onInput={(e) => {
              const input = e.target as HTMLInputElement;
              setDraft(input.value);
              const change = resolveNumberEditorChange(
                input.value,
                input.valueAsNumber,
                allowEmpty === true,
                storageMultiplier,
                input.validity.badInput,
              );
              setInvalid(!change.valid);
              if (change.valid) {
                pendingAcknowledgement.current = { value: toDisplayValue(change.value ?? defaultValue) };
                onChange(change.value);
              }
            }}
            onBlur={(e) => {
              fieldProps.onBlur?.();
              pendingAcknowledgement.current = null;
              // Parents may clamp/reject an edit without changing their stored
              // value, so an effect alone cannot reconcile that valid draft.
              if (displayValue !== undefined || allowEmpty) {
                const restored = String(displayValue ?? '');
                // An invalid native draft may already expose value="". Reset
                // it explicitly even when React's controlled value is unchanged.
                e.currentTarget.value = restored;
                setDraft(restored);
                setInvalid(false);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onClose?.();
              }
            }}
          />
          {invalid && (
            <ErrorMessage>Enter a finite number{allowEmpty ? ' or leave this field blank' : ''}.</ErrorMessage>
          )}
        </>
      )}
    </Field>
  );
};
