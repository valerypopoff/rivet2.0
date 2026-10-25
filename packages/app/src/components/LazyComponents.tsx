import { type FC } from 'react';
import { createLazyComponent } from './createLazyComponent.js';
import { createRetryableModuleLoader } from './retryableModuleLoader.js';
import { useMultilineEditorFontSize, type MultilineEditorFontSizeScope } from '../hooks/useMultilineEditorFontSize.js';
import { useIsNodeEditorResizing } from './nodeEditor/NodeEditorResizeContext.js';
import type { CodeEditorProps } from './CodeEditor.js';

type CodeEditorModule = {
  default: FC<CodeEditorProps>;
  CodeEditor: FC<CodeEditorProps>;
};

const codeEditorLoader = createRetryableModuleLoader<CodeEditorModule>(() => import('./CodeEditor'));

export function preloadCodeEditor(): Promise<CodeEditorModule> {
  return codeEditorLoader.load();
}

export function warmCodeEditor(): void {
  void preloadCodeEditor().catch(() => undefined);
}

const LazyCodeEditorImpl = createLazyComponent(preloadCodeEditor, 'code editor', codeEditorLoader.retry);

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
