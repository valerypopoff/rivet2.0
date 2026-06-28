import { css } from '@emotion/react';
import { useAtomValue } from 'jotai';
import { type CSSProperties, type FC, useCallback, useEffect, useRef, useState } from 'react';
import { themeState } from '../state/settings.js';
import { monaco } from '../utils/monaco/codeEditorMonaco.js';
import { resolveMonacoDisplayTheme } from './codeEditorTheme.js';

const DIFF_EDITOR_LINE_HEIGHT = 20;
const DIFF_EDITOR_MIN_HEIGHT = 56;
const DIFF_EDITOR_MAX_HEIGHT = 720;

const styles = css`
  height: min(58vh, var(--project-compare-monaco-diff-height));
  min-height: ${DIFF_EDITOR_MIN_HEIGHT}px;
  overflow: hidden;
  position: relative;

  &::before {
    background: var(--settings-collapsible-border);
    bottom: 0;
    content: '';
    left: 50%;
    pointer-events: none;
    position: absolute;
    top: 0;
    width: 1px;
    z-index: 3;
  }

  .monaco-diff-editor,
  .monaco-editor,
  .monaco-editor .margin,
  .monaco-editor-background,
  .monaco-editor .inputarea.ime-input,
  .monaco-editor .overflow-guard {
    background: transparent !important;
  }

  .monaco-sash,
  .monaco-scrollable-element > .shadow,
  .monaco-editor .scroll-decoration {
    box-shadow: none !important;
    display: none !important;
  }

  .monaco-editor .decorationsOverviewRuler {
    opacity: 0.85;
  }

  .monaco-scrollable-element > .scrollbar.vertical {
    opacity: 0.8;
  }

  .monaco-scrollable-element > .scrollbar.horizontal {
    display: none !important;
  }

  .original-in-monaco-diff-editor .decorationsOverviewRuler,
  .original-in-monaco-diff-editor .monaco-scrollable-element > .scrollbar.vertical {
    display: none !important;
  }
`;

type ProjectComparisonDiffEditorProps = {
  currentText: string;
  previousText: string;
};

export const ProjectComparisonDiffEditor: FC<ProjectComparisonDiffEditorProps> = ({ currentText, previousText }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor>();
  const previousModelRef = useRef<monaco.editor.ITextModel>();
  const currentModelRef = useRef<monaco.editor.ITextModel>();
  const appTheme = useAtomValue(themeState);
  const resolvedTheme = resolveMonacoDisplayTheme(undefined, appTheme);
  const [editorHeight, setEditorHeight] = useState(() => getEstimatedDiffEditorHeight(previousText, currentText));
  const updateEditorHeight = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const nextHeight = getMeasuredDiffEditorHeight(editor);
    setEditorHeight((height) => (height === nextHeight ? height : nextHeight));
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const previousModel = monaco.editor.createModel(previousText, 'plaintext');
    const currentModel = monaco.editor.createModel(currentText, 'plaintext');
    const editor = monaco.editor.createDiffEditor(container, {
      theme: resolvedTheme,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 0,
      enableSplitViewResizing: false,
      automaticLayout: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      lineNumbers: 'on',
      lineNumbersMinChars: 2,
      lineHeight: DIFF_EDITOR_LINE_HEIGHT,
      padding: {
        bottom: 0,
        top: 0,
      },
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'mouseover',
      overviewRulerBorder: false,
      wordWrap: 'off',
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      scrollbar: {
        alwaysConsumeMouseWheel: false,
        horizontal: 'hidden',
        horizontalScrollbarSize: 0,
      },
    });
    editorRef.current = editor;
    const resizeObserver = new ResizeObserver(() => editor.layout());
    const disposables = [
      editor.onDidUpdateDiff(updateEditorHeight),
      editor.getModifiedEditor().onDidContentSizeChange(updateEditorHeight),
      editor.getOriginalEditor().onDidContentSizeChange(updateEditorHeight),
    ];

    editor.setModel({
      modified: currentModel,
      original: previousModel,
    });
    resizeObserver.observe(container);
    editor.layout();
    updateEditorHeight();

    previousModelRef.current = previousModel;
    currentModelRef.current = currentModel;

    return () => {
      resizeObserver.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
      editorRef.current = undefined;
      previousModelRef.current = undefined;
      currentModelRef.current = undefined;
      editor.dispose();
      previousModel.dispose();
      currentModel.dispose();
    };
    // Monaco diff editor setup is intentionally one-shot; prop changes update the existing models below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    if (previousModelRef.current && previousModelRef.current.getValue() !== previousText) {
      previousModelRef.current.setValue(previousText);
    }

    if (currentModelRef.current && currentModelRef.current.getValue() !== currentText) {
      currentModelRef.current.setValue(currentText);
    }

    if (!editorRef.current) {
      setEditorHeight(getEstimatedDiffEditorHeight(previousText, currentText));
      return;
    }

    updateEditorHeight();
    const animationFrame = requestAnimationFrame(updateEditorHeight);

    return () => cancelAnimationFrame(animationFrame);
  }, [currentText, previousText, updateEditorHeight]);

  useEffect(() => {
    const animationFrame = requestAnimationFrame(() => editorRef.current?.layout());
    return () => cancelAnimationFrame(animationFrame);
  }, [editorHeight]);

  return (
    <div
      ref={containerRef}
      css={styles}
      className="project-compare-monaco-diff-editor"
      style={{ '--project-compare-monaco-diff-height': `${editorHeight}px` } as CSSProperties}
    />
  );
};

function getMeasuredDiffEditorHeight(editor: monaco.editor.IStandaloneDiffEditor): number {
  return clampDiffEditorHeight(
    Math.max(editor.getOriginalEditor().getContentHeight(), editor.getModifiedEditor().getContentHeight()),
  );
}

function getEstimatedDiffEditorHeight(previousText: string, currentText: string): number {
  const lineCount = Math.max(getLineCount(previousText), getLineCount(currentText));
  return clampDiffEditorHeight(lineCount * DIFF_EDITOR_LINE_HEIGHT);
}

function clampDiffEditorHeight(height: number): number {
  return Math.min(DIFF_EDITOR_MAX_HEIGHT, Math.max(DIFF_EDITOR_MIN_HEIGHT, Math.ceil(height)));
}

function getLineCount(text: string): number {
  return Math.max(1, text.split(/\r\n|\r|\n/).length);
}

export default ProjectComparisonDiffEditor;
