import { type ChartNode, type JsonObjectEditorDefinition } from '@valerypopoff/rivet2-core';
import { useMemo, type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { CodeEditor } from './CodeEditor';
import { getHelperMessage } from './editorUtils';
import { formatJsonObjectEditorValue, parseJsonObjectEditorValue } from './jsonObjectEditorValue';
import { useNodeEditorDataChange } from '../nodeEditor/NodeEditorSessionContext.js';
import { isEqual } from 'lodash-es';

function isEquivalentJson(text: string, source: string): boolean {
  const parsed = parseJsonObjectEditorValue(text);
  return !parsed.error && isEqual(parsed.value, parseJsonObjectEditorValue(source).value);
}

function validateJson(text: string): string | undefined {
  return parseJsonObjectEditorValue(text).error;
}

export const JsonObjectEditor: FC<
  SharedEditorProps & {
    editor: JsonObjectEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor, onClose }) => {
  const data = node.data as Record<string, unknown>;
  const value = data[editor.dataKey];
  const formattedValue = useMemo(() => formatJsonObjectEditorValue(value), [value]);
  const helperMessage = getHelperMessage(editor, node.data);
  const changeData = useNodeEditorDataChange(node, onChange);

  const handleChange = (text: string) => {
    if (isReadonly || isDisabled) return;
    const result = parseJsonObjectEditorValue(text);
    if (result.error) return;
    changeData(String(editor.dataKey), result.value);
  };

  return (
    <CodeEditor
      value={formattedValue}
      isEquivalentValue={isEquivalentJson}
      preserveUncommittedDraft
      onChange={handleChange}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      autoFocus={editor.autoFocus}
      label={editor.label}
      name={String(editor.dataKey)}
      helperMessage={helperMessage}
      validateValue={validateJson}
      onClose={onClose}
      language="json"
      enableFolding
      id={node.id}
      nodeType={node.type}
      defaultHeight={editor.height ?? 150}
    />
  );
};
