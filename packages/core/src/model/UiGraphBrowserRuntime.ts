import { getUiGraphJsonOutputFilename } from './UiGraphRuntimeModel.js';

const OUTPUT_MAX_HEIGHT_PX = 800;
const OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO = 0.8;
const OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-min-height';
const OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-max-height';

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
    const contentPadding =
      getPixelValue(contentStyle.paddingTop, 0) + getPixelValue(contentStyle.paddingBottom, 0);
    const verticalBorder = Math.max(0, output.offsetHeight - output.clientHeight);
    const minimumHeight = Math.ceil(header.getBoundingClientRect().height + contentPadding + lineHeight + verticalBorder);
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
