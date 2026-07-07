import { type FC, useLayoutEffect, useRef } from 'react';
import { ensureMonacoLanguage, monaco } from '../utils/monaco';
import { useAtomValue } from 'jotai';
import { themeState } from '../state/settings';
import { resolveMonacoDisplayTheme, resolveMonacoForeground } from './codeEditorTheme.js';

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
}> = ({ text, language, theme, className, wrapWords = false }) => {
  const bodyRef = useRef<HTMLPreElement>(null);
  const colorizeRequestRef = useRef(0);
  const appTheme = useAtomValue(themeState);
  const resolvedTheme = resolveMonacoDisplayTheme(theme, appTheme);
  const foreground = resolveMonacoForeground(theme, appTheme);
  const preClassName = className ? `${className} ${resolvedTheme}` : resolvedTheme;

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
  }, [text, language, resolvedTheme, wrapWords]);

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
