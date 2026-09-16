import { type ToggleEditorDefinition, type ChartNode } from '@valerypopoff/rivet2-core';
import { type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';
import { LabeledToggle } from '../LabeledToggle';
import { applyToggleEditorChange, type ToggleEditorDataChangeDefinition } from './toggleEditorData';

export const DefaultToggleEditor: FC<
  SharedEditorProps & {
    editor: ToggleEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const value = (data[editor.dataKey] as boolean | undefined) ?? editor.defaultValue;
  const helperMessage = getHelperMessage(editor, node.data);
  return (
    <ToggleEditor
      value={value}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      onChange={(newValue) => {
        const toggleEditor = editor as ToggleEditorDefinition<ChartNode> & ToggleEditorDataChangeDefinition;
        onChange({
          ...node,
          data: applyToggleEditorChange(data, toggleEditor, Boolean(newValue)),
        });
      }}
      label={editor.label}
      name={editor.dataKey}
      helperMessage={helperMessage}
    />
  );
};

export const ToggleEditor: FC<{
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  label: string;
  name?: string;
  helperMessage?: string;
}> = ({ value, onChange, isReadonly, isDisabled, label, name, helperMessage }) => {
  const toggleId = name ?? label;

  return (
    <div className="toggle-editor-field">
      <LabeledToggle
        id={toggleId}
        isChecked={value}
        isDisabled={isReadonly || isDisabled}
        onChange={onChange}
        label={label}
        className="toggle-editor-control-row"
        switchClassName="toggle-editor-switch"
        labelClassName="toggle-editor-label"
        helperMessage={helperMessage}
      />
    </div>
  );
};
