import type * as Monaco from 'monaco-editor';

export const DISABLE_AMBIGUOUS_UNICODE_HIGHLIGHT_COMMAND =
  'editor.action.unicodeHighlight.disableHighlightingOfAmbiguousCharacters';

export type MonacoEditorApi = Pick<typeof Monaco.editor, 'addCommand' | 'getEditors' | 'onDidCreateEditor'>;

function setAmbiguousUnicodeHighlighting(editor: Monaco.editor.ICodeEditor, enabled: boolean): void {
  editor.updateOptions({
    unicodeHighlight: {
      ambiguousCharacters: enabled,
    },
  });
}

/**
 * Monaco's built-in banner invokes a configuration command. In its standalone
 * build that command changes the shared configuration service, but existing
 * editors do not inherit the change. Keep the same command id, but apply the
 * option directly to every Rivet Monaco surface instead.
 */
export function installAmbiguousUnicodeHighlightCommand(editorApi: MonacoEditorApi): void {
  let ambiguousHighlightingEnabled = true;

  const applyToAllEditors = () => {
    for (const editor of editorApi.getEditors()) {
      setAmbiguousUnicodeHighlighting(editor, ambiguousHighlightingEnabled);
    }
  };

  editorApi.addCommand({
    id: DISABLE_AMBIGUOUS_UNICODE_HIGHLIGHT_COMMAND,
    run: () => {
      ambiguousHighlightingEnabled = false;
      applyToAllEditors();
    },
  });

  editorApi.onDidCreateEditor((editor) => {
    setAmbiguousUnicodeHighlighting(editor, ambiguousHighlightingEnabled);
  });

  applyToAllEditors();
}
