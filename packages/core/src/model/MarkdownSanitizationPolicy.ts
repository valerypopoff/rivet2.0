export const RIVET_MARKDOWN_ALLOWED_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

export const RIVET_MARKDOWN_ALLOWED_ATTRIBUTES = ['class', 'href', 'title'] as const;

// http(s), mailto, hashes, and ordinary relative links. Protocol-relative and
// active/unknown schemes are intentionally excluded.
export const RIVET_MARKDOWN_ALLOWED_URI_REGEXP_SOURCE =
  '^(?:https?:|mailto:|#|\\?(?:[^/]|$)|/(?!/)|\\.{1,2}/|[a-z0-9._~-]+(?:[/?#]|$))';

export type RivetMarkdownSanitizerPolicy = {
  allowedAttributes: readonly string[];
  allowedTags: readonly string[];
  allowedUriRegExpSource: string;
};

export const RIVET_MARKDOWN_SANITIZER_POLICY: RivetMarkdownSanitizerPolicy = Object.freeze({
  allowedAttributes: RIVET_MARKDOWN_ALLOWED_ATTRIBUTES,
  allowedTags: RIVET_MARKDOWN_ALLOWED_TAGS,
  allowedUriRegExpSource: RIVET_MARKDOWN_ALLOWED_URI_REGEXP_SOURCE,
});
