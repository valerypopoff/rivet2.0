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
    </div>
  );
};
