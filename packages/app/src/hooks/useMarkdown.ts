import { Renderer, marked } from 'marked';
import { useMemo } from 'react';

export type MarkdownRenderOptions = {
  allowHtml?: boolean;
};

let escapedHtmlRenderer: Renderer | undefined;

function getEscapedHtmlRenderer() {
  escapedHtmlRenderer ??= new Renderer();
  escapedHtmlRenderer.html = (html) => escapeHtml(html);
  return escapedHtmlRenderer;
}

function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function useMarkdown(text: string | undefined, enabled: boolean = true, options?: MarkdownRenderOptions) {
  const allowHtml = options?.allowHtml ?? true;

  return useMemo(() => {
    if (!enabled) {
      return { __html: '' };
    }

    const converted = allowHtml ? marked(text ?? '') : marked(text ?? '', { renderer: getEscapedHtmlRenderer() });

    return { __html: converted };
  }, [text, enabled, allowHtml]);
}
