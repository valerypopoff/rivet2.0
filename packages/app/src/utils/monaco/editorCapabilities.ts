import { installJsStyleCommentHighlighting } from './commentHighlighting.js';
import { installJsonSchemaRequiredDefinitionNavigation, monaco } from './codeEditorMonaco.js';
import { jsonEscapeText, jsonUnescapeText } from './editorTextTransforms.js';
import { installEditorInterpolationSupport } from './interpolationEditorSupport.js';
import { runCodeEditorSpellcheck } from './spellcheck.js';
import type { ResolvedCodeEditorCapabilities } from './editorCapabilityModel.js';

export class EditorDisposableStore implements monaco.IDisposable {
  private disposables: monaco.IDisposable[] = [];

  add<T extends monaco.IDisposable | undefined>(disposable: T): T {
    if (disposable) {
      this.disposables.push(disposable);
    }
    return disposable;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0).reverse()) {
      disposable.dispose();
    }
  }
}

export function installCodeEditorCapabilities(
  editor: monaco.editor.IStandaloneCodeEditor,
  capabilities: ResolvedCodeEditorCapabilities,
): monaco.IDisposable {
  const store = new EditorDisposableStore();

  if (capabilities.interpolation) {
    store.add(installEditorInterpolationSupport(editor, capabilities.interpolation));
  }
  if (capabilities.commentHighlighting) {
    store.add(installJsStyleCommentHighlighting(editor));
  }
  if (capabilities.definitionNavigation) {
    store.add(installJsonSchemaRequiredDefinitionNavigation(editor));
  }
  if (capabilities.textTools) {
    installEditorTextToolActions(editor).forEach((disposable) => store.add(disposable));
  }

  return store;
}

export function installCodeEditorSpellcheckAction(
  editor: monaco.editor.IStandaloneCodeEditor,
  runSpellcheck?: () => void | Promise<void>,
): monaco.IDisposable {
  return editor.addAction({
    id: 'rivet.checkSpelling',
    label: 'Check spelling',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 1.5,
    run: async () => {
      try {
        await (runSpellcheck ? runSpellcheck() : runCodeEditorSpellcheck(editor));
      } catch {
        // A dictionary load failure must not break Monaco's context menu.
      }
    },
  });
}

function getSelectedEditorText(
  editor: monaco.editor.IStandaloneCodeEditor,
): { selection: monaco.Selection; text: string } | undefined {
  const model = editor.getModel();
  const selection = editor.getSelection();

  if (!model || !selection || selection.isEmpty()) {
    return undefined;
  }

  return { selection, text: model.getValueInRange(selection) };
}

function replaceSelectedEditorText(
  editor: monaco.editor.IStandaloneCodeEditor,
  getReplacement: (selectedText: string) => string | undefined,
): void {
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) {
    return;
  }

  const selected = getSelectedEditorText(editor);
  const replacement = selected && getReplacement(selected.text);

  if (!selected || replacement == null || replacement === selected.text) {
    return;
  }

  editor.pushUndoStop();
  editor.executeEdits('rivet.textTools', [{ range: selected.selection, text: replacement, forceMoveMarkers: true }]);
  editor.pushUndoStop();
}

async function runMonacoPrettify(editor: monaco.editor.IStandaloneCodeEditor): Promise<void> {
  if (editor.getOption(monaco.editor.EditorOption.readOnly)) {
    return;
  }

  const selection = editor.getSelection();
  const action = editor.getAction(
    selection && !selection.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument',
  );

  if (action?.isSupported()) {
    await action.run();
  }
}

function installEditorTextToolActions(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable[] {
  return [
    editor.addAction({
      id: 'rivet.prettify',
      label: 'Prettify',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.6,
      run: () => runMonacoPrettify(editor),
    }),
    editor.addAction({
      id: 'rivet.jsonEscapeSelection',
      label: 'JSON escape',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.7,
      run: () => replaceSelectedEditorText(editor, jsonEscapeText),
    }),
    editor.addAction({
      id: 'rivet.jsonUnescapeSelection',
      label: 'JSON unescape',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.8,
      run: () => replaceSelectedEditorText(editor, jsonUnescapeText),
    }),
  ];
}
