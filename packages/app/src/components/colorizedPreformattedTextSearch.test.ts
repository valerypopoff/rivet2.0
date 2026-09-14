import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import {
  MATCH_ACTIVE_CLASS,
  MATCH_ATTRIBUTE,
  MATCH_CLASS,
  type SearchMatchRange,
} from './nodeOutput/fullscreenOutputSearch.js';
import { applyColorizedPreformattedTextSearchHighlight } from './colorizedPreformattedTextSearch.js';

test('reapplies the active search mark after colorization replaces paged JSON HTML', () => {
  const dom = new JSDOM('<!doctype html><body><pre></pre></body>');
  const restoreGlobals = installDomGlobals(dom);

  try {
    const preview = dom.window.document.querySelector('pre')!;
    const text = '{\n  "request_id": "paged-search-marker"\n}';
    const matchRange = getMatchRange(text, 'paged-search-marker');

    preview.textContent = text;
    applyColorizedPreformattedTextSearchHighlight(preview, matchRange);
    assertHighlight(preview, 'paged-search-marker');

    // Monaco renders line breaks as BR nodes and replaces the original text DOM.
    // This reproduces the later page-colorization write that previously erased
    // the mark after search had selected the correct chunk.
    preview.innerHTML =
      '<span style="color: rgb(100, 200, 255)">{</span><br><span style="color: rgb(100, 200, 255)">  "request_id": </span><span style="color: rgb(200, 160, 120)">"paged-search-marker"</span><br><span style="color: rgb(100, 200, 255)">}</span>';
    applyColorizedPreformattedTextSearchHighlight(preview, matchRange);
    assertHighlight(preview, 'paged-search-marker');

    applyColorizedPreformattedTextSearchHighlight(preview, null);
    assert.equal(preview.querySelectorAll(`[${MATCH_ATTRIBUTE}="true"]`).length, 0);
    assert.equal(getTextWithLineBreaks(preview), text);
  } finally {
    restoreGlobals();
  }
});

function getMatchRange(text: string, match: string): SearchMatchRange {
  const startOffset = text.indexOf(match);
  assert.notEqual(startOffset, -1);
  return {
    startOffset,
    endOffset: startOffset + match.length,
  };
}

function assertHighlight(preview: HTMLElement, expectedText: string): void {
  const highlights = preview.querySelectorAll<HTMLElement>(`[${MATCH_ATTRIBUTE}="true"]`);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0]?.textContent, expectedText);
  assert.ok(highlights[0]?.classList.contains(MATCH_CLASS));
  assert.ok(highlights[0]?.classList.contains(MATCH_ACTIVE_CLASS));
}

function getTextWithLineBreaks(element: HTMLElement): string {
  return Array.from(element.childNodes)
    .map((node) =>
      node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).tagName === 'BR' ? '\n' : node.textContent,
    )
    .join('');
}

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ['document', 'Node', 'NodeFilter', 'window'] as const;
  const previousDescriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    Node: { configurable: true, value: dom.window.Node },
    NodeFilter: { configurable: true, value: dom.window.NodeFilter },
    window: { configurable: true, value: dom.window },
  });

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
