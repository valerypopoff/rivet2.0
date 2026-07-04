import { css } from '@emotion/react';
import { useAtomValue } from 'jotai';
import { Suspense, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type FC } from 'react';
import { monaco } from '../../utils/monaco.js';
import { themeState } from '../../state/settings.js';
import { LazyCodeEditor } from '../LazyComponents.js';
import type { CodeEditorDisplayOptions } from '../CodeEditor.js';
import { resolveMonacoDisplayTheme } from '../codeEditorTheme.js';
import { useFullscreenOutputSearchContext } from '../nodeOutput/FullscreenOutputSearchContext.js';
import {
  findMatchRanges,
  MATCH_ACTIVE_CLASS,
  MATCH_CLASS,
  PROVIDER_ATTRIBUTE,
  type SearchMatchRange,
} from '../nodeOutput/fullscreenOutputSearch.js';
import { JsonStringPreviewAffordance } from './JsonStringPreviewAffordance.js';

const OUTPUT_CODE_LINE_HEIGHT = 20;
const OUTPUT_CODE_MIN_HEIGHT = 28;
const OUTPUT_CODE_EDITOR_DISPLAY_OPTIONS: CodeEditorDisplayOptions = {
  fontFamily: 'var(--font-family-monospace)',
  lineHeight: OUTPUT_CODE_LINE_HEIGHT,
  padding: { top: 0, bottom: 0 },
  roundedSelection: false,
  selectionHighlight: false,
  occurrencesHighlight: false,
  renderLineHighlight: 'none',
};

const foldingCodeBlockStyles = css`
  --fullscreen-output-folding-line-height: ${OUTPUT_CODE_LINE_HEIGHT}px;
  --fullscreen-output-folding-min-height: ${OUTPUT_CODE_MIN_HEIGHT}px;

  min-width: 0;

  .folding-code-editor-shell {
    min-width: 0;
    overflow: visible;
  }

  .editor-container,
  .monaco-editor {
    width: 100%;
    height: 100%;
  }

  .monaco-editor,
  .monaco-editor .margin,
  .monaco-editor-background,
  .monaco-editor .inputarea.ime-input,
  .monaco-editor .overflow-guard {
    background: transparent !important;
  }

  .monaco-editor .decorationsOverviewRuler,
  .monaco-editor .scrollbar.vertical {
    display: none !important;
  }

  .monaco-editor .scrollbar.horizontal {
    opacity: 0.6;
  }

  .${MATCH_CLASS} {
    background: rgba(255, 214, 10, 0.3);
  }

  .${MATCH_ACTIVE_CLASS} {
    background: rgba(255, 214, 10, 0.75);
    color: #000;
  }

  .fullscreen-output-code-loading {
    align-items: center;
    color: var(--grey-lighter);
    display: flex;
    font-family: var(--font-family-mono);
    font-size: var(--ui-font-size-sm);
    min-height: 140px;
  }

  .json-string-preview-button {
    align-items: center;
    background: color-mix(in srgb, var(--modal-surface-bg) 86%, var(--primary) 14%);
    border: 1px solid var(--foldable-section-border);
    border-radius: 4px;
    color: var(--grey-lightest);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-family);
    font-size: 10px;
    font-weight: 700;
    height: 18px;
    justify-content: center;
    opacity: 0.78;
    padding: 0 4px;
    pointer-events: auto;
    transform: translate(4px, 1px);
  }

  .json-string-preview-button:hover,
  .json-string-preview-button:focus-visible {
    border-color: var(--primary);
    color: var(--primary);
    opacity: 1;
    outline: none;
  }

  .json-string-preview-popover {
    background: var(--modal-surface-bg);
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    color: var(--grey-lightest);
    max-width: calc(100vw - 24px);
    min-width: 260px;
    position: fixed;
    z-index: 4000;
  }

  .json-string-preview-popover-header {
    align-items: center;
    border-bottom: 1px solid var(--foldable-section-border);
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
  }

  .json-string-preview-popover-header > span {
    color: var(--grey-light);
    flex: 1;
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    min-width: 0;
  }

  .json-string-preview-copy-button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--grey-light);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--ui-font-size-sm);
    gap: 4px;
    padding: 2px 4px;
  }

  .json-string-preview-copy-button:hover,
  .json-string-preview-copy-button:focus-visible {
    color: var(--primary);
    outline: none;
  }

  .json-string-preview-copy-button svg {
    height: 14px;
    width: 14px;
  }

  .json-string-preview-popover pre {
    color: var(--grey-lightest);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    margin: 0;
    max-height: 280px;
    overflow: auto;
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-string-preview-resize-handle {
    background: transparent;
    border: 0;
    bottom: 0;
    cursor: ew-resize;
    padding: 0;
    position: absolute;
    right: -4px;
    top: 0;
    width: 10px;
  }

  .json-string-preview-resize-handle::after {
    background: color-mix(in srgb, var(--primary) 70%, transparent);
    border-radius: 999px;
    bottom: 12px;
    content: '';
    opacity: 0;
    position: absolute;
    right: 4px;
    top: 12px;
    transition: opacity 120ms ease-out;
    width: 2px;
  }

  .json-string-preview-resize-handle:hover::after,
  .json-string-preview-resize-handle:focus-visible::after {
    opacity: 1;
  }

  .json-string-preview-resize-handle:focus-visible {
    outline: none;
  }
`;

type FoldingCodeBlockProps = {
  text: string;
  language: string;
  wrapLines: boolean;
  searchProvider?: boolean;
  activeMatchRange?: SearchMatchRange | null;
};

export const FoldingCodeBlock: FC<FoldingCodeBlockProps> = ({
  text,
  language,
  wrapLines,
  searchProvider = true,
  activeMatchRange,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>();
  const decorationIdsRef = useRef<string[]>([]);
  const matchRangesRef = useRef<SearchMatchRange[]>([]);
  const activeMatchIndexRef = useRef<number | null>(null);
  const [mountedEditor, setMountedEditor] = useState<monaco.editor.IStandaloneCodeEditor>();
  const rawProviderId = useId();
  const providerId = `folding-code-output-${rawProviderId}`;
  const fullscreenOutputSearchContext = useFullscreenOutputSearchContext();
  const fullscreenOutputSearch = searchProvider ? fullscreenOutputSearchContext : null;
  const appTheme = useAtomValue(themeState);
  const resolvedTheme = resolveMonacoDisplayTheme(undefined, appTheme);
  const lineCount = useMemo(() => Math.max(1, text.split(/\r\n|\r|\n/).length), [text]);
  const estimatedHeight = useMemo(
    () => Math.max(OUTPUT_CODE_MIN_HEIGHT, lineCount * OUTPUT_CODE_LINE_HEIGHT),
    [lineCount],
  );
  const [editorHeight, setEditorHeight] = useState(estimatedHeight);
  const shellHeight = `${Math.max(OUTPUT_CODE_MIN_HEIGHT, editorHeight)}px`;

  const handleContentHeightChange = useCallback((height: number) => {
    const nextHeight = Math.max(OUTPUT_CODE_MIN_HEIGHT, Math.ceil(height));
    setEditorHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
  }, []);

  const scrollbar = useMemo(
    (): monaco.editor.IEditorScrollbarOptions => ({
      alwaysConsumeMouseWheel: false,
      handleMouseWheel: false,
      vertical: 'hidden',
      verticalScrollbarSize: 0,
      horizontal: wrapLines ? 'hidden' : 'auto',
      horizontalScrollbarSize: wrapLines ? 0 : undefined,
    }),
    [wrapLines],
  );

  const clearSearchDecorations = useCallback(() => {
    const editor = editorRef.current;

    if (!editor) {
      decorationIdsRef.current = [];
      return;
    }

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
  }, []);

  const revealMatchRange = useCallback((matchRange: SearchMatchRange) => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model || !matchRange) {
      return;
    }

    const start = model.getPositionAt(matchRange.startOffset);
    const end = model.getPositionAt(matchRange.endOffset);
    const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

    editor.revealRangeInCenterIfOutsideViewport(range);
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>(`.${MATCH_ACTIVE_CLASS}`)?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      });
    });
  }, []);

  const updateSearchDecorations = useCallback((activeMatchIndex: number | null) => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model) {
      decorationIdsRef.current = [];
      return;
    }

    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      matchRangesRef.current.map((matchRange, localMatchIndex) => {
        const start = model.getPositionAt(matchRange.startOffset);
        const end = model.getPositionAt(matchRange.endOffset);
        const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);

        return {
          range,
          options: {
            inlineClassName:
              activeMatchIndex === localMatchIndex ? `${MATCH_CLASS} ${MATCH_ACTIVE_CLASS}` : MATCH_CLASS,
          },
        };
      }),
    );
  }, []);

  const activateMatch = useCallback(
    (localMatchIndex: number) => {
      activeMatchIndexRef.current = localMatchIndex;
      updateSearchDecorations(localMatchIndex);

      const matchRange = matchRangesRef.current[localMatchIndex];
      if (matchRange) {
        revealMatchRange(matchRange);
      }
    },
    [revealMatchRange, updateSearchDecorations],
  );

  const clearActiveMatch = useCallback(() => {
    activeMatchIndexRef.current = null;
    updateSearchDecorations(null);
  }, [updateSearchDecorations]);

  const clearMatches = useCallback(() => {
    activeMatchIndexRef.current = null;
    matchRangesRef.current = [];
    clearSearchDecorations();
  }, [clearSearchDecorations]);

  const activateExternalMatchRange = useCallback(
    (matchRange: SearchMatchRange) => {
      matchRangesRef.current = [matchRange];
      activeMatchIndexRef.current = 0;
      updateSearchDecorations(0);
      revealMatchRange(matchRange);
    },
    [revealMatchRange, updateSearchDecorations],
  );

  const handleEditorMount = (editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
    setMountedEditor(editor);

    if (!searchProvider && activeMatchRange) {
      activateExternalMatchRange(activeMatchRange);
      return;
    }

    updateSearchDecorations(activeMatchIndexRef.current);

    if (searchProvider && activeMatchIndexRef.current != null) {
      activateMatch(activeMatchIndexRef.current);
    }
  };

  useLayoutEffect(() => {
    if (!fullscreenOutputSearch || !rootRef.current) {
      return;
    }

    return fullscreenOutputSearch.registerProvider({
      id: providerId,
      rootElement: rootRef.current,
      getMatchRanges: (query) => {
        const matchRanges = findMatchRanges(text, query);
        matchRangesRef.current = matchRanges;
        activeMatchIndexRef.current = null;
        updateSearchDecorations(null);
        return matchRanges;
      },
      activateMatch,
      clearActiveMatch,
      clearMatches,
    });
  }, [
    activateMatch,
    clearActiveMatch,
    clearMatches,
    fullscreenOutputSearch,
    providerId,
    text,
    updateSearchDecorations,
  ]);

  useLayoutEffect(() => {
    clearMatches();
    activeMatchIndexRef.current = null;
    matchRangesRef.current = [];
    setEditorHeight(estimatedHeight);
  }, [clearMatches, estimatedHeight, text]);

  useLayoutEffect(() => {
    if (searchProvider) {
      return;
    }

    clearMatches();

    if (activeMatchRange) {
      activateExternalMatchRange(activeMatchRange);
    }
  }, [activateExternalMatchRange, activeMatchRange, clearMatches, searchProvider, text]);

  return (
    <div
      ref={rootRef}
      css={foldingCodeBlockStyles}
      className="fullscreen-output-folding-code"
      data-lang={language}
      {...(fullscreenOutputSearch ? { [PROVIDER_ATTRIBUTE]: providerId } : undefined)}
    >
      <div className="folding-code-editor-shell" style={{ height: shellHeight }}>
        <Suspense fallback={<div className="fullscreen-output-code-loading">Loading editor...</div>}>
          <LazyCodeEditor
            text={text}
            language={language}
            theme={resolvedTheme}
            isReadonly
            enableFolding
            wordWrap={wrapLines ? 'on' : 'off'}
            displayOptions={OUTPUT_CODE_EDITOR_DISPLAY_OPTIONS}
            scrollBeyondLastLine={false}
            scrollbar={scrollbar}
            editorRef={editorRef}
            onEditorMount={handleEditorMount}
            onContentHeightChange={handleContentHeightChange}
          />
        </Suspense>
      </div>
      <JsonStringPreviewAffordance
        editor={mountedEditor}
        enabled={language === 'json'}
        rootRef={rootRef}
        text={text}
        widgetId={`${providerId}-json-string-preview`}
      />
    </div>
  );
};
