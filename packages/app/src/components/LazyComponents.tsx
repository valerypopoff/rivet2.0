import { lazy, type FC } from 'react';
import {
  useMultilineEditorFontSize,
  type MultilineEditorFontSizeScope,
} from '../hooks/useMultilineEditorFontSize.js';
import { useIsNodeEditorResizing } from './nodeEditor/NodeEditorResizeContext.js';
import type { CodeEditorProps } from './CodeEditor.js';

type CodeEditorModule = {
  default: FC<CodeEditorProps>;
  CodeEditor: FC<CodeEditorProps>;
};

let codeEditorPreloadPromise: Promise<CodeEditorModule> | undefined;

export function preloadCodeEditor(): Promise<CodeEditorModule> {
  codeEditorPreloadPromise ??= import('./CodeEditor').catch((error) => {
    codeEditorPreloadPromise = undefined;
    throw error;
  });
  return codeEditorPreloadPromise;
}

export function warmCodeEditor(): void {
  void preloadCodeEditor().catch(() => undefined);
}

const LazyCodeEditorImpl = lazy(preloadCodeEditor);

type LazyCodeEditorProps = Omit<
  CodeEditorProps,
  'fontSize' | 'onFontSizeKeyDown' | 'onFontSizeWheel' | 'isNodeEditorResizing'
> & {
  fontSizeScope?: MultilineEditorFontSizeScope;
};

export const LazyCodeEditor: FC<LazyCodeEditorProps> = (props) => {
  const { fontSizeScope = 'editor', ...codeEditorProps } = props;
  const {
    fontSize,
    handleKeyDown: handleFontSizeKeyDown,
    handleWheel: handleFontSizeWheel,
  } = useMultilineEditorFontSize(fontSizeScope);
  const isNodeEditorResizing = useIsNodeEditorResizing();

  return (
    <LazyCodeEditorImpl
      {...codeEditorProps}
      fontSize={fontSize}
      onFontSizeKeyDown={handleFontSizeKeyDown}
      onFontSizeWheel={handleFontSizeWheel}
      isNodeEditorResizing={isNodeEditorResizing}
    />
  );
};
