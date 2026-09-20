import { Field, HelperMessage } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { type DropdownEditorDefinition, type ChartNode } from '@valerypopoff/rivet2-core';
import { useRef, type FC, useState } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';
import Portal from '@atlaskit/portal';

export const DefaultDropdownEditor: FC<
  SharedEditorProps & {
    editor: DropdownEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);

  return (
    <DropdownEditor
      value={data[editor.dataKey] as string | undefined}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
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
      ariaLabel={editor.ariaLabel}
      name={editor.dataKey}
      helperMessage={helperMessage}
      options={editor.options}
      defaultValue={editor.defaultValue}
    />
  );
};

export const DropdownEditor: FC<{
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  autoFocus?: boolean;
  label: string;
  ariaLabel?: string;
  name?: string;
  helperMessage?: string;
  onClose?: () => void;
  options: { label: string; value: string }[];
  defaultValue?: string;
}> = ({
  value,
  onChange,
  isReadonly,
  isDisabled,
  autoFocus,
  label,
  ariaLabel,
  name,
  helperMessage,
  onClose,
  options,
  defaultValue,
}) => {
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);

  const selectedValue =
    value == null
      ? options.find((option) => option.value === defaultValue)
      : options.find((option) => option.value === value);

  if (!label) {
    return (
      <>
        {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
        <Select
          name={name}
          aria-label={ariaLabel || name}
          isDisabled={isReadonly || isDisabled}
          options={options}
          value={selectedValue}
          menuPortalTarget={menuPortalTarget}
          autoFocus={autoFocus}
          onChange={(selected) => onChange(selected!.value)}
        />
        <Portal>
          <div ref={setMenuPortalTarget} />
        </Portal>
      </>
    );
  }

  return (
    <Field name={name ?? label} label={label} isDisabled={isReadonly || isDisabled}>
      {({ fieldProps }) => (
        <>
          {helperMessage && <HelperMessage>{helperMessage}</HelperMessage>}
          <Select
            {...fieldProps}
            name={name}
            aria-label={ariaLabel || label}
            options={options}
            value={selectedValue}
            menuPortalTarget={menuPortalTarget}
            autoFocus={autoFocus}
            onChange={(selected) => onChange(selected!.value)}
          />
          <Portal>
            <div ref={setMenuPortalTarget} />
          </Portal>
        </>
      )}
    </Field>
  );
};
