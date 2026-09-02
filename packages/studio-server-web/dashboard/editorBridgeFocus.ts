const EDITOR_CANVAS_SELECTOR = '.node-canvas';
const CANVAS_FOCUS_PRESERVE_SELECTOR =
  'input, textarea, select, button, [contenteditable="true"], [contenteditable=""], [role="textbox"]';

export const isSaveShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyS' || event.key.toLowerCase() === 's');

export const isEditorFindShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyF' || event.key.toLowerCase() === 'f');

export const isEditorDuplicateShortcutEvent = (event: KeyboardEvent) =>
  (event.ctrlKey || event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.code === 'KeyD' || event.key.toLowerCase() === 'd');

/**
 * F2 is a tree-management shortcut. Keep it deliberately narrow so it does
 * not claim modified platform shortcuts or retrigger while the key is held.
 */
export const isPlainF2ShortcutEvent = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'shiftKey'>,
) => event.key === 'F2' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.repeat && !event.shiftKey;

export function focusElement(element: HTMLElement | HTMLIFrameElement | null) {
  if (!element) {
    return;
  }

  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

export function focusIframeElement(iframe: HTMLIFrameElement | null) {
  focusElement(iframe);
}

export function focusHostedEditorFrame() {
  const frameElement = window.frameElement;

  if (!(frameElement instanceof HTMLIFrameElement)) {
    return;
  }

  focusElement(frameElement);
}

export function isEditableElement(element: Element | null | undefined): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  return ['input', 'textarea', 'select'].includes(element.tagName.toLowerCase());
}

export function shouldPreserveCanvasFocusTarget(target: Element) {
  return target.closest(CANVAS_FOCUS_PRESERVE_SELECTOR) !== null || (target instanceof HTMLElement && target.isContentEditable);
}

export function focusHostedEditorCanvas(target: Element) {
  const canvasElement = target.closest(EDITOR_CANVAS_SELECTOR);

  if (!(canvasElement instanceof HTMLElement) || shouldPreserveCanvasFocusTarget(target)) {
    return;
  }

  const activeElement = document.activeElement;
  if (isEditableElement(activeElement)) {
    activeElement.blur();
  }

  canvasElement.tabIndex = -1;
  focusElement(canvasElement);
}
