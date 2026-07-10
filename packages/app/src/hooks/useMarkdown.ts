import { Renderer, marked } from 'marked';
import { useMemo } from 'react';
import { sanitizeMarkdownHtml } from '../utils/markdown/sanitizeMarkdownHtml.js';

export type MarkdownRenderMode = 'plain' | 'trusted-static' | 'untrusted';

export type MarkdownRenderOptions = {
  /** @deprecated Rich HTML is sanitized regardless. Use mode when choosing a trust boundary. */
  allowHtml?: boolean;
  disableLinks?: boolean;
  mode?: MarkdownRenderMode;
};

declare const sanitizedMarkdownHtmlBrand: unique symbol;
export type SanitizedMarkdownHtml = { __html: string; readonly [sanitizedMarkdownHtmlBrand]: true };

function unescapeMarkdownInline(value: unknown): string {
  return `${value ?? ''}`.replace(/\\([\\`*_[\]{}()#+\-.!|])/g, '$1');
}

export function escapeHtml(value: unknown): string {
  return `${value ?? ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function createMarkdownRenderer(options: MarkdownRenderOptions): Renderer | undefined {
  if (!options.disableLinks && options.allowHtml !== false) return undefined;

  const renderer = new Renderer();
  if (options.allowHtml === false) renderer.html = (html) => escapeHtml(html);
  if (options.disableLinks) {
    renderer.link = (_href, _title, text) => escapeHtml(unescapeMarkdownInline(text));
  }
  return renderer;
}

export function renderMarkdown(text: string | undefined, enabled: boolean = true, options: MarkdownRenderOptions = {}) {
  if (!enabled) return '';
  if (options.mode === 'plain') return escapeHtml(text);

  const rendered = String(marked(text ?? '', { renderer: createMarkdownRenderer(options) }));
  return options.mode === 'trusted-static' ? rendered : sanitizeMarkdownHtml(rendered);
}

export function toSanitizedMarkdownHtml(html: string): SanitizedMarkdownHtml {
  return { __html: html } as SanitizedMarkdownHtml;
}

export function useMarkdown(
  text: string | undefined,
  enabled: boolean = true,
  options: MarkdownRenderOptions = {},
): SanitizedMarkdownHtml {
  const { allowHtml, disableLinks, mode } = options;
  return useMemo(
    () => toSanitizedMarkdownHtml(renderMarkdown(text, enabled, { allowHtml, disableLinks, mode })),
    [text, enabled, allowHtml, disableLinks, mode],
  );
}
