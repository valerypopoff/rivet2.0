import { type ChartNode, type EditorDefinition } from '@valerypopoff/rivet2-core';

export function getHelperMessage(editor: EditorDefinition<ChartNode>, data: ChartNode['data']) {
  return typeof editor.helperMessage === 'function'
    ? editor.helperMessage(data) || undefined
    : editor.helperMessage || undefined;
}

export function getPostEditorHelperMessage(editor: EditorDefinition<ChartNode>, data: ChartNode['data']) {
  if (editor.type !== 'code') {
    return undefined;
  }

  return typeof editor.postEditorHelperMessage === 'function'
    ? editor.postEditorHelperMessage(data) || undefined
    : editor.postEditorHelperMessage || undefined;
}

type EditorDefinitionWithDataKey = EditorDefinition<ChartNode> & { dataKey: unknown };

function hasEditorDataKey(editor: EditorDefinition<ChartNode>): editor is EditorDefinitionWithDataKey {
  return 'dataKey' in editor && editor.dataKey != null;
}

export function getEditorListKey(editor: EditorDefinition<ChartNode>, index: number): string {
  if (hasEditorDataKey(editor)) {
    return `${editor.type}:${String(editor.dataKey)}`;
  }

  if (editor.type === 'custom') {
    return `${editor.type}:${editor.customEditorId}`;
  }

  return `${editor.type}:${editor.label}:${index}`;
}

export function getCodeEditorDataKey(editor: EditorDefinition<ChartNode>): string | undefined {
  return editor.type === 'code' ? String(editor.dataKey) : undefined;
}

export type EditorRenderRow =
  | {
      type: 'single';
      editor: EditorDefinition<ChartNode>;
      index: number;
      key: string;
    }
  | {
      type: 'inline';
      editors: EditorDefinition<ChartNode>[];
      startIndex: number;
      key: string;
    };

export function getEditorRenderRows(editors: EditorDefinition<ChartNode>[]): EditorRenderRow[] {
  const rows: EditorRenderRow[] = [];

  for (let index = 0; index < editors.length; index++) {
    const editor = editors[index]!;

    if (editor.layout !== 'inline') {
      rows.push({
        type: 'single',
        editor,
        index,
        key: getEditorListKey(editor, index),
      });
      continue;
    }

    const inlineEditors = [editor];
    let inlineEndIndex = index + 1;

    while (editors[inlineEndIndex]?.layout === 'inline') {
      inlineEditors.push(editors[inlineEndIndex]!);
      inlineEndIndex++;
    }

    rows.push({
      type: 'inline',
      editors: inlineEditors,
      startIndex: index,
      key: `inline-${getEditorListKey(editor, index)}`,
    });
    index = inlineEndIndex - 1;
  }

  return rows;
}
