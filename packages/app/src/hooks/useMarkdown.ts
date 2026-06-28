import { Renderer, marked } from 'marked';
import { useMemo } from 'react';

export type MarkdownRenderOptions = {
  allowHtml?: boolean;
  disableLinks?: boolean;
};

let escapedHtmlRenderer: Renderer | undefined;

function getEscapedHtmlRenderer() {
  escapedHtmlRenderer ??= new Renderer();
  escapedHtmlRenderer.html = (html) => escapeHtml(html);
  return escapedHtmlRenderer;
}

function unescapeMarkdownInline(value: unknown): string {
  return `${value ?? ''}`.replace(/\\([\\`*_[\]{}()#+\-.!|])/g, '$1');
}

function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createMarkdownRenderer(options: Required<MarkdownRenderOptions>): Renderer | undefined {
  if (!options.disableLinks) {
    return options.allowHtml ? undefined : getEscapedHtmlRenderer();
  }

  const renderer = new Renderer();

  if (!options.allowHtml) {
    renderer.html = (html) => escapeHtml(html);
  }

  renderer.link = (_href, _title, text) => escapeHtml(unescapeMarkdownInline(text));
  return renderer;
}

export function renderMarkdown(text: string | undefined, enabled: boolean = true, options?: MarkdownRenderOptions) {
  const allowHtml = options?.allowHtml ?? true;
  const disableLinks = options?.disableLinks ?? false;

  if (!enabled) {
    return '';
  }

  const renderer = createMarkdownRenderer({ allowHtml, disableLinks });
  return renderer == null ? marked(text ?? '') : marked(text ?? '', { renderer });
}

export function useMarkdown(text: string | undefined, enabled: boolean = true, options?: MarkdownRenderOptions) {
  const allowHtml = options?.allowHtml ?? true;
  const disableLinks = options?.disableLinks ?? false;

  return useMemo(() => {
    return { __html: renderMarkdown(text, enabled, { allowHtml, disableLinks }) };
  }, [text, enabled, allowHtml, disableLinks]);
}
