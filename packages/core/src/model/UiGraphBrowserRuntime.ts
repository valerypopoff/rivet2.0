import { getUiGraphJsonOutputFilename } from './UiGraphRuntimeModel.js';

const OUTPUT_MAX_HEIGHT_PX = 800;
const OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO = 0.8;
const OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-min-height';
const OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-max-height';
const CHAT_SEARCH_MATCH_CLASS = 'rivet-web-app-chat-search-match';
const CHAT_SEARCH_ACTIVE_MATCH_CLASS = 'rivet-web-app-chat-search-match-active';

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getPixelValue = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const setStyleProperty = (element: HTMLElement, property: string, value: string): void => {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
};

/**
 * Limits an expanded Output card's native resize range to one visible content
 * line through its rendered value. Short, naturally-sized outputs have no resize
 * handle because resizing them would only add blank space.
 */
export function observeUiGraphOutputResizeBounds(output: HTMLElement): () => void {
  const ownerWindow = output.ownerDocument.defaultView;
  let scheduledFrame: number | undefined;

  const sync = () => {
    scheduledFrame = undefined;
    if (!ownerWindow) return;
    const header = output.querySelector<HTMLElement>('.rivet-web-app-output-header');
    const content = output.querySelector<HTMLElement>('.rivet-web-app-output-content');
    const body = output.querySelector<HTMLElement>('.rivet-web-app-output-content-body');

    if (!header || !content || !body) {
      output.classList.remove('rivet-web-app-output-resizable');
      output.classList.remove('rivet-web-app-output-scrollable');
      output.style.removeProperty(OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY);
      output.style.removeProperty(OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY);
      return;
    }

    const bodyStyle = ownerWindow.getComputedStyle(body);
    const lineHeight = getPixelValue(bodyStyle.lineHeight, getPixelValue(bodyStyle.fontSize, 16) * 1.5);
    const contentStyle = ownerWindow.getComputedStyle(content);
    const contentPadding = getPixelValue(contentStyle.paddingTop, 0) + getPixelValue(contentStyle.paddingBottom, 0);
    const verticalBorder = Math.max(0, output.offsetHeight - output.clientHeight);
    const minimumHeight = Math.ceil(
      header.getBoundingClientRect().height + contentPadding + lineHeight + verticalBorder,
    );
    const naturalHeight = Math.ceil(
      header.getBoundingClientRect().height + contentPadding + Math.max(body.scrollHeight, lineHeight) + verticalBorder,
    );
    const viewportHeight = ownerWindow?.innerHeight ?? OUTPUT_MAX_HEIGHT_PX / OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO;
    const maximumViewportHeight = Math.min(viewportHeight * OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO, OUTPUT_MAX_HEIGHT_PX);

    output.classList.toggle('rivet-web-app-output-resizable', naturalHeight > maximumViewportHeight);
    output.classList.toggle('rivet-web-app-output-scrollable', body.scrollHeight > body.clientHeight);
    setStyleProperty(output, OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY, `${minimumHeight}px`);
    setStyleProperty(output, OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY, `${naturalHeight}px`);
  };

  const scheduleSync = () => {
    if (scheduledFrame != null) return;
    if (ownerWindow?.requestAnimationFrame) {
      scheduledFrame = ownerWindow.requestAnimationFrame(sync);
    } else {
      sync();
    }
  };

  const resizeObserver = ownerWindow?.ResizeObserver ? new ownerWindow.ResizeObserver(scheduleSync) : undefined;
  resizeObserver?.observe(output);

  const mutationObserver = ownerWindow?.MutationObserver ? new ownerWindow.MutationObserver(scheduleSync) : undefined;
  mutationObserver?.observe(output, { childList: true, characterData: true, subtree: true });
  output.addEventListener('load', scheduleSync, true);
  ownerWindow?.addEventListener('resize', scheduleSync);
  sync();

  return () => {
    if (scheduledFrame != null) ownerWindow?.cancelAnimationFrame(scheduledFrame);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    output.removeEventListener('load', scheduleSync, true);
    ownerWindow?.removeEventListener('resize', scheduleSync);
  };
}

/** Copies rendered web-app output without requiring the modern Clipboard API. */
export async function copyUiGraphText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Preview hosts and non-secure origins may not expose the Clipboard API.
  }

  const textArea = document.createElement('textarea');
  textArea.className = 'rivet-web-app-clipboard-fallback';
  textArea.value = value;
  try {
    document.body.append(textArea);
    textArea.select();
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  } finally {
    textArea.remove();
  }
}

/** Downloads the exact JSON string rendered by a web-app output component. */
export function downloadUiGraphJsonOutput(value: string, appName: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = getUiGraphJsonOutputFilename(appName);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Replaces visible chat-message text matches with safe `<mark>` elements. This
 * operates on rendered Markdown DOM rather than source Markdown, so search
 * follows what the user can actually read.
 */
export function highlightUiGraphChatSearchMatches(
  messagesElement: HTMLElement,
  query: string,
  requestedActiveIndex = 0,
): { activeIndex: number; matches: HTMLElement[] } {
  clearUiGraphChatSearchMatches(messagesElement);

  const searchText = query.trim();
  if (!searchText) {
    return { activeIndex: -1, matches: [] };
  }

  const document = messagesElement.ownerDocument;
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(messagesElement, 4);
  let node = walker.nextNode();
  while (node) {
    if (node.parentElement?.closest('script, style, textarea')) {
      node = walker.nextNode();
      continue;
    }

    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  const matches: HTMLElement[] = [];
  for (const textNode of textNodes) {
    const value = textNode.data;
    const ranges: Array<{ end: number; start: number }> = [];
    const expression = new RegExp(escapeRegularExpression(searchText), 'gi');
    for (const match of value.matchAll(expression)) {
      if (match.index != null && match[0]) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    if (ranges.length === 0 || !textNode.parentNode) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      fragment.append(value.slice(cursor, range.start));
      const match = document.createElement('mark');
      match.className = CHAT_SEARCH_MATCH_CLASS;
      match.textContent = value.slice(range.start, range.end);
      fragment.append(match);
      matches.push(match);
      cursor = range.end;
    }
    fragment.append(value.slice(cursor));
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  if (matches.length === 0) {
    return { activeIndex: -1, matches };
  }

  const activeIndex = ((requestedActiveIndex % matches.length) + matches.length) % matches.length;
  matches[activeIndex]?.classList.add(CHAT_SEARCH_ACTIVE_MATCH_CLASS);
  return { activeIndex, matches };
}

/** Removes transient chat-search markup without changing the rendered message text. */
export function clearUiGraphChatSearchMatches(messagesElement: HTMLElement): void {
  for (const match of messagesElement.querySelectorAll<HTMLElement>(`.${CHAT_SEARCH_MATCH_CLASS}`)) {
    match.replaceWith(messagesElement.ownerDocument.createTextNode(match.textContent ?? ''));
  }
  messagesElement.normalize();
}

/** Reveals a rendered message or search match inside the chat's own scroll region. */
export function revealUiGraphChatElement(
  messagesElement: HTMLElement,
  element: HTMLElement | undefined,
  alignment: 'center' | 'start' = 'center',
): void {
  if (!element || !messagesElement.contains(element)) {
    return;
  }

  const containerRect = messagesElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const maxScrollTop = Math.max(0, messagesElement.scrollHeight - messagesElement.clientHeight);
  const offset =
    elementRect.top -
    containerRect.top -
    (alignment === 'center' ? (messagesElement.clientHeight - elementRect.height) / 2 : 0);
  messagesElement.scrollTop = Math.max(0, Math.min(maxScrollTop, messagesElement.scrollTop + offset));
}

/** Centers the active chat-search match inside the chat's own scroll region. */
export const revealUiGraphChatSearchMatch = revealUiGraphChatElement;
