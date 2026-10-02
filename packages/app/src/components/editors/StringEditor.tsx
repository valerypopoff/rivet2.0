import { Field, HelperMessage } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { type StringEditorDefinition, type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';
import { useNodeEditorDataChange } from '../nodeEditor/NodeEditorSessionContext.js';

function useDebouncedStringCommit(onChange: (value: string | undefined) => void, debounceMs: number | undefined) {
  const timeoutRef = useRef<number | undefined>();
  const pendingValueRef = useRef<string | undefined>();
  const onChangeRef = useRef(onChange);
  const shouldDebounce = debounceMs != null && debounceMs > 0;

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  const flushPending = useCallback(() => {
    const pendingValue = pendingValueRef.current;

    clearPendingTimeout();
    pendingValueRef.current = undefined;

    if (pendingValue !== undefined) {
      onChangeRef.current(pendingValue);
    }
  }, [clearPendingTimeout]);

  const clearPendingCommit = useCallback(() => {
    clearPendingTimeout();
    pendingValueRef.current = undefined;
  }, [clearPendingTimeout]);

  const commit = useCallback(
    (value: string | undefined) => {
      if (!shouldDebounce) {
        onChangeRef.current(value);
        return;
      }

      clearPendingTimeout();
      pendingValueRef.current = value;
      timeoutRef.current = window.setTimeout(flushPending, debounceMs);
    },
    [clearPendingTimeout, debounceMs, flushPending, shouldDebounce],
  );

  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  return { commit, flushPending, clearPendingCommit };
}

export const DefaultStringEditor: FC<
  SharedEditorProps & {
    editor: StringEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor, onClose }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);
  const changeData = useNodeEditorDataChange(node, onChange);
  return (
    <StringEditor
      value={data[editor.dataKey] as string | undefined}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      autoFocus={editor.autoFocus}
      onChange={(newValue) => {
        if (!isReadonly && !isDisabled) changeData(editor.dataKey, newValue);
      }}
      label={editor.label}
      name={editor.dataKey}
      placeholder={editor.placeholder}
      maxLength={editor.maxLength}
      // Canonical node data must include the last keystroke before Save/switch.
      // Generic non-node fields may still opt into commit debouncing.
      helperMessage={helperMessage}
      onClose={onClose}
    />
  );
};

export const StringEditor: FC<{
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  autoFocus?: boolean;
  label: string;
  name?: string;
  helperMessage?: string;
  placeholder?: string;
  maxLength?: number;
  commitDebounceMs?: number;
  onClose?: () => void;
}> = ({
  value,
  onChange,
  isReadonly,
  isDisabled,
  label,
  name,
  autoFocus,
  helperMessage,
  placeholder,
  maxLength,
  commitDebounceMs,
  onClose,
}) => {
  const [draftValue, setDraftValue] = useState(value ?? '');
  const { commit, flushPending, clearPendingCommit } = useDebouncedStringCommit(onChange, commitDebounceMs);
  const shouldDebounce = commitDebounceMs != null && commitDebounceMs > 0;

  useEffect(() => {
    if (!shouldDebounce) {
      flushPending();
      return;
    }

    clearPendingCommit();
    setDraftValue(value ?? '');
  }, [clearPendingCommit, flushPending, shouldDebounce, value]);

  return (
    <Field name={name ?? label} label={label} isDisabled={isDisabled}>
      {({ fieldProps }) => (
        <>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <TextField
            {...fieldProps}
            value={shouldDebounce ? draftValue : value}
            isReadOnly={isReadonly}
            autoFocus={autoFocus}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            maxLength={maxLength}
            onChange={(e) => {
              const nextValue = (e.target as HTMLInputElement).value;

              if (shouldDebounce) {
                setDraftValue(nextValue);
              }

              commit(nextValue);
            }}
            onBlur={() => {
              fieldProps.onBlur();
              flushPending();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                flushPending();
                onClose?.();
              } else if (e.key === 'Enter') {
                flushPending();
              }
            }}
          />
        </>
      )}
    </Field>
  );
};
