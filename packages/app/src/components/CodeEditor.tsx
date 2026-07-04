import { useLatest } from 'ahooks';
import { type FC, type MutableRefObject, useEffect, useRef } from 'react';
import { ensureCodeEditorMonacoLanguages, monaco } from '../utils/monaco/codeEditorMonaco.js';
import { installEditorInterpolationSupport } from '../utils/monaco/interpolationEditorSupport.js';
import { type EditorInterpolationSyntax } from '../utils/monaco/interpolationDiagnostics.js';
import { installJsStyleCommentHighlighting } from '../utils/monaco/commentHighlighting.js';
import { shouldHighlightJsStyleComments } from '../utils/monaco/commentRangeScanner.js';
import {
  getCodeEditorModelUri,
  getCodeEditorViewState,
  getOrCreateCodeEditorModel,
  saveCodeEditorViewState,
} from '../utils/monaco/codeEditorModelCache.js';

const DEFAULT_MONACO_THEME = 'vs-dark';
const DEFAULT_MULTILINE_EDITOR_FONT_SIZE = 14;

ensureCodeEditorMonacoLanguages();

type MultilineEditorFontSizeKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
  preventDefault(): void;
  stopPropagation(): void;
};

type MultilineEditorFontSizeWheelEvent = Pick<WheelEvent, 'deltaY' | 'ctrlKey' | 'metaKey' | 'altKey'> & {
  preventDefault(): void;
  stopPropagation(): void;
};

export type CodeEditorProps = {
  text: string;
  isReadonly?: boolean;
  onChange?: (newText: string) => void;
  language?: string;
  interpolationSyntax?: EditorInterpolationSyntax;
  theme?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: monaco.IKeyboardEvent) => void;
  onBlur?: () => void;
  editorRef?: MutableRefObject<monaco.editor.IStandaloneCodeEditor | undefined>;
  onEditorMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
  scrollBeyondLastLine?: boolean;
  enableFolding?: boolean;
  wordWrap?: 'on' | 'off';
  scrollbar?: monaco.editor.IEditorScrollbarOptions;
  onContentHeightChange?: (height: number) => void;
  errorLineHighlight?: {
    line: number;
    source: string;
  };
  fontSize?: number;
  onFontSizeKeyDown?: (event: MultilineEditorFontSizeKeyEvent) => boolean;
  onFontSizeWheel?: (event: MultilineEditorFontSizeWheelEvent) => boolean;
  isNodeEditorResizing?: boolean;
  modelCacheKey?: string;
};

export const CodeEditor: FC<CodeEditorProps> = ({
  text,
  isReadonly,
  onChange,
  language,
  interpolationSyntax,
  theme,
  autoFocus,
  onKeyDown,
  onBlur,
  editorRef,
  onEditorMount,
  scrollBeyondLastLine,
  enableFolding,
  wordWrap = 'on',
  scrollbar,
  onContentHeightChange,
  errorLineHighlight,
  fontSize = DEFAULT_MULTILINE_EDITOR_FONT_SIZE,
  onFontSizeKeyDown,
  onFontSizeWheel,
  isNodeEditorResizing = false,
  modelCacheKey,
}) => {
  const editorContainer = useRef<HTMLDivElement>(null);
  const editorInstance = useRef<monaco.editor.IStandaloneCodeEditor>();
  const errorLineDecorationIds = useRef<string[]>([]);
  const pendingResizeLayoutRef = useRef(false);

  const onChangeLatest = useLatest(onChange);
  const onContentHeightChangeLatest = useLatest(onContentHeightChange);
  const isNodeEditorResizingRef = useRef(isNodeEditorResizing);

  isNodeEditorResizingRef.current = isNodeEditorResizing;

  useEffect(() => {
    const container = editorContainer.current;

    if (!container) {
      return;
    }

    const modelUri = modelCacheKey ? monaco.Uri.parse(getCodeEditorModelUri(modelCacheKey)) : undefined;
    const { model, isCached } = getOrCreateCodeEditorModel({
      cacheKey: modelCacheKey,
      text,
      getExistingModel: modelUri ? () => monaco.editor.getModel(modelUri) : undefined,
      createModel: () => monaco.editor.createModel(text, language, modelUri),
    });

    const editor = monaco.editor.create(container, {
      theme: theme ?? DEFAULT_MONACO_THEME,
      lineNumbers: 'on',
      glyphMargin: false,
      folding: enableFolding ?? false,
      foldingStrategy: enableFolding ? 'auto' : undefined,
      showFoldingControls: enableFolding ? 'mouseover' : undefined,
      foldingHighlight: enableFolding ? true : undefined,
      unfoldOnClickAfterEndOfLine: enableFolding ? false : undefined,
      lineNumbersMinChars: 2,
      minimap: {
        enabled: false,
      },
      fontSize,
      wordWrap,
      readOnly: isReadonly,
      model,
      scrollBeyondLastLine,
      scrollbar: {
        ...scrollbar,
        alwaysConsumeMouseWheel: false,
      },
    });

    const cachedViewState = getCodeEditorViewState(modelCacheKey);
    if (cachedViewState) {
      editor.restoreViewState(cachedViewState);
    }

    editor.layout();
    onContentHeightChangeLatest.current?.(editor.getContentHeight());
    const interpolationSupport =
      interpolationSyntax != null ? installEditorInterpolationSupport(editor, interpolationSyntax) : undefined;
    const commentHighlightingSupport = shouldHighlightJsStyleComments(language)
      ? installJsStyleCommentHighlighting(editor)
      : undefined;

    const onResize = () => {
      // Resizing the node settings panel can emit a dense stream of ResizeObserver
      // events. Defer Monaco relayout until the drag ends to keep panel resize smooth.
      if (isNodeEditorResizingRef.current) {
        pendingResizeLayoutRef.current = true;
        return;
      }

      pendingResizeLayoutRef.current = false;
      editor.layout();
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);
    const contentSizeChangeDisposable = editor.onDidContentSizeChange((event) => {
      if (event.contentHeightChanged) {
        onContentHeightChangeLatest.current?.(editor.getContentHeight());
      }
    });

    editor.onDidChangeModelContent(() => {
      onChangeLatest.current?.(editor.getValue());
    });

    editor.onDidBlurEditorWidget(() => {
      onBlur?.();
    });

    editorInstance.current = editor;
    if (editorRef) {
      editorRef.current = editor;
    }
    onEditorMount?.(editor);

    const currentOnChange = onChangeLatest.current;

    if (model.getValue() !== text) {
      currentOnChange?.(model.getValue());
    }

    return () => {
      currentOnChange?.(editor.getValue());
      saveCodeEditorViewState(modelCacheKey, editor.saveViewState());
      editorInstance.current = undefined;
      if (editorRef) {
        editorRef.current = undefined;
      }
      resizeObserver?.disconnect();
      contentSizeChangeDisposable.dispose();
      interpolationSupport?.dispose();
      commentHighlightingSupport?.dispose();
      editor.dispose();
      if (!isCached) {
        model.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorInstance.current;

    if (!editor) {
      return undefined;
    }

    const dispose = editor.onKeyDown((event) => {
      if (onFontSizeKeyDown?.(event.browserEvent)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      onKeyDown?.(event);
    });

    return () => {
      dispose.dispose();
    };
  }, [onFontSizeKeyDown, onKeyDown]);

  useEffect(() => {
    const container = editorContainer.current;

    if (!container || !onFontSizeWheel) {
      return undefined;
    }

    const handleWheel = (event: WheelEvent) => {
      onFontSizeWheel(event);
    };

    container.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel, true);
    };
  }, [onFontSizeWheel]);

  useEffect(() => {
    if (autoFocus) {
      editorInstance.current?.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    const editor = editorInstance.current;
    const model = editor?.getModel();

    if (!editor || !model || !isReadonly || onChangeLatest.current || modelCacheKey) {
      return;
    }

    if (model.getValue() === text) {
      return;
    }

    model.setValue(text);
    editor.layout();
    onContentHeightChangeLatest.current?.(editor.getContentHeight());
  }, [isReadonly, modelCacheKey, onChangeLatest, onContentHeightChangeLatest, text]);

  useEffect(() => {
    const editor = editorInstance.current;

    if (!editor) {
      return;
    }

    editor.updateOptions({
      fontSize,
    });
    editor.layout();
    onContentHeightChange?.(editor.getContentHeight());
  }, [fontSize, onContentHeightChange]);

  useEffect(() => {
    const editor = editorInstance.current;

    if (!editor) {
      return;
    }

    editor.updateOptions({
      wordWrap,
    });
    editor.layout();
    onContentHeightChange?.(editor.getContentHeight());
  }, [onContentHeightChange, wordWrap]);

  useEffect(() => {
    const editor = editorInstance.current;

    if (!editor) {
      return;
    }

    editor.updateOptions({
      scrollbar: {
        ...scrollbar,
        alwaysConsumeMouseWheel: false,
      },
    });
    editor.layout();
    onContentHeightChange?.(editor.getContentHeight());
  }, [onContentHeightChange, scrollbar]);

  useEffect(() => {
    const editor = editorInstance.current;
    const model = editor?.getModel();

    if (!editor || !model) {
      return;
    }

    const line =
      errorLineHighlight &&
      text === errorLineHighlight.source &&
      errorLineHighlight.line >= 1 &&
      errorLineHighlight.line <= model.getLineCount()
        ? errorLineHighlight.line
        : undefined;

    errorLineDecorationIds.current = editor.deltaDecorations(
      errorLineDecorationIds.current,
      line
        ? [
            {
              range: new monaco.Range(line, 1, line, 1),
              options: {
                className: 'code-node-runtime-error-line',
                isWholeLine: true,
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            },
          ]
        : [],
    );
  }, [errorLineHighlight, text]);

  useEffect(() => {
    if (isNodeEditorResizing) {
      return;
    }

    if (!pendingResizeLayoutRef.current) {
      return;
    }

    pendingResizeLayoutRef.current = false;
    editorInstance.current?.layout();
  }, [isNodeEditorResizing]);

  return <div ref={editorContainer} className="editor-container" />;
};

export default CodeEditor;
