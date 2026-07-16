import {
  getUiGraphProgressiveJsonOutputChunks,
  observeUiGraphOutputResizeBounds,
  type GraphProgress,
} from '@valerypopoff/rivet2-core/web-app-runtime';

export type FocusedTextControl = {
  componentId: string;
  scrollLeft: number;
  scrollTop: number;
  selectionDirection: 'backward' | 'forward' | 'none';
  selectionEnd: number;
  selectionStart: number;
};

export function createWebAppElement<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  attributes: Record<string, unknown> = {},
  children: Node[] = [],
): HTMLElementTagNameMap[TagName] {
  const element = document.createElement(tagName);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'className') element.className = String(value ?? '');
    else if (key === 'text') element.textContent = String(value ?? '');
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value != null) element.setAttribute(key, String(value));
  }
  element.append(...children);
  return element;
}

export function observeOutputResizeBounds(container: ParentNode): () => void {
  const disposers = [...container.querySelectorAll<HTMLElement>('.rivet-web-app-output')].map(
    observeUiGraphOutputResizeBounds,
  );
  return () => disposers.forEach((dispose) => dispose());
}

export function captureFocusedTextControl(root: HTMLElement): FocusedTextControl | undefined {
  const activeElement = document.activeElement;
  if (
    !(activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) ||
    !root.contains(activeElement)
  ) {
    return undefined;
  }
  const componentId = activeElement.dataset.rivetFocusComponentId;
  if (!componentId) return undefined;

  return {
    componentId,
    scrollLeft: activeElement.scrollLeft,
    scrollTop: activeElement.scrollTop,
    selectionDirection: activeElement.selectionDirection ?? 'none',
    selectionEnd: activeElement.selectionEnd ?? activeElement.value.length,
    selectionStart: activeElement.selectionStart ?? activeElement.value.length,
  };
}

export function restoreFocusedTextControl(root: HTMLElement, focused: FocusedTextControl): void {
  const control = [
    ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-rivet-focus-component-id]'),
  ].find((candidate) => candidate.dataset.rivetFocusComponentId === focused.componentId);
  if (!control) return;

  control.focus();
  control.setSelectionRange(focused.selectionStart, focused.selectionEnd, focused.selectionDirection);
  control.scrollLeft = focused.scrollLeft;
  control.scrollTop = focused.scrollTop;
}

export function renderActionProgress(progress: GraphProgress | undefined): HTMLElement | undefined {
  if (!progress) return undefined;
  const children: Node[] = [];
  if (progress.message) children.push(createWebAppElement('span', { text: progress.message }));
  if (progress.percent != null) {
    children.push(
      createWebAppElement('progress', { 'aria-label': 'Action progress', max: '100', value: progress.percent }),
    );
  }
  return createWebAppElement('div', { 'aria-live': 'polite', className: 'rivet-web-app-progress' }, children);
}

export function createProgressiveJsonOutput(value: string): HTMLPreElement {
  const pre = createWebAppElement('pre', { className: 'rivet-web-app-output-json' });
  const chunks = getUiGraphProgressiveJsonOutputChunks(value);
  if (!chunks) {
    pre.textContent = value;
    return pre;
  }

  pre.append(document.createTextNode(chunks[0]!));
  let nextChunkIndex = 1;
  const appendNextChunk = () => {
    if (!pre.isConnected || nextChunkIndex >= chunks.length) return;
    pre.append(document.createTextNode(chunks[nextChunkIndex]!));
    nextChunkIndex += 1;
    scheduleAnimationFrame(appendNextChunk);
  };
  scheduleAnimationFrame(appendNextChunk);
  return pre;
}

function scheduleAnimationFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else window.setTimeout(callback, 0);
}
