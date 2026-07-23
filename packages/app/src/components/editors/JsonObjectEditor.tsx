import { type ChartNode, type JsonObjectEditorDefinition } from '@valerypopoff/rivet2-core';
import { useEffect, useMemo, useState, type FC } from 'react';
import { type SharedEditorProps } from './SharedEditorProps';
import { CodeEditor } from './CodeEditor';
import { getHelperMessage } from './editorUtils';
import { formatJsonObjectEditorValue, parseJsonObjectEditorValue } from './jsonObjectEditorValue';

export const JsonObjectEditor: FC<
  SharedEditorProps & {
    editor: JsonObjectEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor, onClose }) => {
  const data = node.data as Record<string, unknown>;
  const value = data[editor.dataKey];
  const formattedValue = useMemo(() => formatJsonObjectEditorValue(value), [value]);
  const helperMessage = getHelperMessage(editor, node.data);
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    setValidationError(undefined);
  }, [editor.dataKey, formattedValue, node.id]);

  const handleChange = (text: string) => {
    const result = parseJsonObjectEditorValue(text);
    if (result.error) {
      setValidationError(result.error);
      return;
    }

    setValidationError(undefined);
    onChange({
      ...node,
      data: {
        ...data,
        [editor.dataKey]: result.value,
      },
    });
  };

  return (
    <CodeEditor
      value={formattedValue}
      onChange={handleChange}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      autoFocus={editor.autoFocus}
      label={editor.label}
      name={String(editor.dataKey)}
      helperMessage={helperMessage}
      postEditorHelperMessage={validationError}
      onClose={onClose}
      language="json"
      enableFolding
      id={node.id}
      nodeType={node.type}
      defaultHeight={editor.height ?? 150}
    />
  );
};
