import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DISABLE_AMBIGUOUS_UNICODE_HIGHLIGHT_COMMAND,
  installAmbiguousUnicodeHighlightCommand,
  type MonacoEditorApi,
} from './unicodeHighlighting.js';

type UpdateOptions = {
  unicodeHighlight: {
    ambiguousCharacters: boolean;
  };
};

class FakeEditor {
  readonly updates: UpdateOptions[] = [];

  updateOptions(options: UpdateOptions): void {
    this.updates.push(options);
  }
}

function createFakeEditorApi(initialEditors: FakeEditor[] = []) {
  const editors = [...initialEditors];
  const createListeners: Array<(editor: FakeEditor) => void> = [];
  const commands = new Map<string, () => void>();

  return {
    addCommand({ id, run }: { id: string; run: () => void }) {
      commands.set(id, run);
      return { dispose() {} };
    },
    getEditors() {
      return editors;
    },
    onDidCreateEditor(listener: (editor: FakeEditor) => void) {
      createListeners.push(listener);
      return { dispose() {} };
    },
    createEditor() {
      const editor = new FakeEditor();
      editors.push(editor);
      createListeners.forEach((listener) => listener(editor));
      return editor;
    },
    runCommand(id: string) {
      commands.get(id)?.();
    },
  };
}

test('Disable Ambiguous Highlight updates existing and future standalone editors', () => {
  const firstExistingEditor = new FakeEditor();
  const secondExistingEditor = new FakeEditor();
  const editorApi = createFakeEditorApi([firstExistingEditor, secondExistingEditor]);

  installAmbiguousUnicodeHighlightCommand(editorApi as unknown as MonacoEditorApi);

  assert.deepEqual(firstExistingEditor.updates, [{ unicodeHighlight: { ambiguousCharacters: true } }]);
  assert.deepEqual(secondExistingEditor.updates, [{ unicodeHighlight: { ambiguousCharacters: true } }]);

  editorApi.runCommand(DISABLE_AMBIGUOUS_UNICODE_HIGHLIGHT_COMMAND);

  assert.deepEqual(firstExistingEditor.updates.at(-1), { unicodeHighlight: { ambiguousCharacters: false } });
  assert.deepEqual(secondExistingEditor.updates.at(-1), { unicodeHighlight: { ambiguousCharacters: false } });

  const laterEditor = editorApi.createEditor();

  assert.deepEqual(laterEditor.updates, [{ unicodeHighlight: { ambiguousCharacters: false } }]);
});
