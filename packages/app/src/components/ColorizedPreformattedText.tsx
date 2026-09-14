import { type FC, useCallback, useLayoutEffect, useRef } from 'react';
import { ensureMonacoLanguage, monaco } from '../utils/monaco';
import { useAtomValue } from 'jotai';
import { themeState } from '../state/settings';
import { resolveMonacoDisplayTheme, resolveMonacoForeground } from './codeEditorTheme.js';
import { applyColorizedPreformattedTextSearchHighlight } from './colorizedPreformattedTextSearch.js';
import { scheduleFullscreenOutputSearchTargetReveal } from './nodeOutput/fullscreenOutputSearchViewport.js';
import type { SearchMatchRange } from './nodeOutput/fullscreenOutputSearch.js';

function normalizeColorizedWordWrapSpaces(element: HTMLElement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    node.textContent = node.textContent?.replace(/\u00A0/g, ' ') ?? null;
  }
}

function inlineMonacoTokenStyles(element: HTMLElement) {
  for (const token of element.querySelectorAll<HTMLElement>('span[class*="mtk"]')) {
    const style = getComputedStyle(token);

    token.style.color = style.color;
    token.style.fontStyle = style.fontStyle;
    token.style.fontWeight = style.fontWeight;
    token.style.textDecoration = style.textDecoration;
    token.removeAttribute('class');
  }
}

async function colorizeStableHtml(text: string, language: string, theme: string): Promise<string> {
  const scratchRoot = document.createElement('div');
  const colorizedBody = document.createElement('pre');

  scratchRoot.style.cssText = [
    'contain: strict',
    'height: 1px',
    'left: -10000px',
    'overflow: hidden',
    'position: fixed',
    'top: -10000px',
    'visibility: hidden',
    'width: 1px',
  ].join(';');
  colorizedBody.textContent = text;
  colorizedBody.dataset.lang = language;
  scratchRoot.appendChild(colorizedBody);
  document.body.appendChild(scratchRoot);

  try {
    await monaco.editor.colorizeElement(colorizedBody, { theme });
    inlineMonacoTokenStyles(colorizedBody);

    return colorizedBody.innerHTML;
  } finally {
    scratchRoot.remove();
  }
}

export const ColorizedPreformattedText: FC<{
  text: string;
  language: string;
  theme?: string;
  className?: string;
  wrapWords?: boolean;
  /** Undefined leaves ordinary DOM-owned search highlights alone; null clears an external match. */
  activeSearchMatchRange?: SearchMatchRange | null;
}> = ({ text, language, theme, className, wrapWords = false, activeSearchMatchRange }) => {
  const bodyRef = useRef<HTMLPreElement>(null);
  const colorizeRequestRef = useRef(0);
  const activeSearchMatchRangeRef = useRef(activeSearchMatchRange);
  const cancelSearchRevealRef = useRef<(() => void) | undefined>(undefined);
  const appTheme = useAtomValue(themeState);
  const resolvedTheme = resolveMonacoDisplayTheme(theme, appTheme);
  const foreground = resolveMonacoForeground(theme, appTheme);
  const preClassName = className ? `${className} ${resolvedTheme}` : resolvedTheme;

  // Async colorization must use the latest committed search selection, rather
  // than a value from a render React may later discard.
  useLayoutEffect(() => {
    activeSearchMatchRangeRef.current = activeSearchMatchRange;
  }, [activeSearchMatchRange]);

  const applyActiveSearchMatch = useCallback((body: HTMLPreElement) => {
    const activeMatchRange = activeSearchMatchRangeRef.current;
    if (activeMatchRange === undefined) {
      return;
    }

    cancelSearchRevealRef.current?.();
    const highlightElement = applyColorizedPreformattedTextSearchHighlight(body, activeMatchRange);
    cancelSearchRevealRef.current = highlightElement
      ? scheduleFullscreenOutputSearchTargetReveal(() => (highlightElement.isConnected ? highlightElement : null))
      : undefined;
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    const colorizeRequest = colorizeRequestRef.current + 1;
    const body = bodyRef.current;
    colorizeRequestRef.current = colorizeRequest;

    if (!body) {
      return;
    }

    body.textContent = text;
    body.dataset.lang = language;

    void ensureMonacoLanguage(language)
      .then(() => colorizeStableHtml(text, language, resolvedTheme))
      .then((html) => {
        if (cancelled || colorizeRequestRef.current !== colorizeRequest || bodyRef.current !== body) {
          return;
        }

        body.innerHTML = html;

        if (wrapWords) {
          normalizeColorizedWordWrapSpaces(body);
        }

        applyActiveSearchMatch(body);
      })
      .catch((error) => {
        if (import.meta.env.DEV && !cancelled && colorizeRequestRef.current === colorizeRequest) {
          console.warn('Failed to colorize Monaco preview text', {
            language,
            error,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyActiveSearchMatch, text, language, resolvedTheme, wrapWords]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || activeSearchMatchRange === undefined) {
      return;
    }

    applyActiveSearchMatch(body);

    return () => {
      cancelSearchRevealRef.current?.();
      cancelSearchRevealRef.current = undefined;
      applyColorizedPreformattedTextSearchHighlight(body, null);
    };
  }, [activeSearchMatchRange, applyActiveSearchMatch, text]);

  return (
    <pre
      ref={bodyRef}
      className={preClassName}
      data-lang={language}
      style={foreground ? { color: foreground } : undefined}
    >
      {text}
    </pre>
  );
};

export default ColorizedPreformattedText;
