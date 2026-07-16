import createDOMPurify, { type Config, type DOMPurify, type WindowLike } from 'dompurify';
import { RIVET_MARKDOWN_SANITIZER_POLICY } from '@valerypopoff/rivet2-core';

const sanitizerConfig: Config = {
  ALLOWED_ATTR: [...RIVET_MARKDOWN_SANITIZER_POLICY.allowedAttributes],
  ALLOWED_TAGS: [...RIVET_MARKDOWN_SANITIZER_POLICY.allowedTags],
  ALLOWED_URI_REGEXP: new RegExp(RIVET_MARKDOWN_SANITIZER_POLICY.allowedUriRegExpSource, 'i'),
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

let browserSanitizer: DOMPurify | undefined;
let browserSanitizerRoot: WindowLike | undefined;

function getBrowserSanitizer(): DOMPurify {
  if (typeof window === 'undefined') throw new Error('Markdown HTML sanitization requires a DOM window.');
  const root = window as unknown as WindowLike;
  if (browserSanitizer && browserSanitizerRoot === root) return browserSanitizer;
  browserSanitizer = createDOMPurify(root);
  browserSanitizerRoot = root;
  return browserSanitizer;
}

export function createMarkdownHtmlSanitizer(root: WindowLike): (html: string) => string {
  const sanitizer = createDOMPurify(root);
  return (html) => String(sanitizer.sanitize(html, sanitizerConfig));
}

export function sanitizeMarkdownHtml(html: string): string {
  return String(getBrowserSanitizer().sanitize(html, sanitizerConfig));
}
