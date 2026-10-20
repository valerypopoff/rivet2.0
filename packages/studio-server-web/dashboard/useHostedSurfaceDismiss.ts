import { useEffect } from 'react';

const EDITOR_FRAME_SELECTOR = 'iframe.dashboard-editor-frame';
const OUTSIDE_EVENTS = ['pointerdown', 'click', 'contextmenu'] as const;

/** Listen only to the opposite hosted surface, never synthesize input or move focus. */
export function subscribeToOtherHostedSurface(owner: Document, onDismiss: () => void): () => void {
  const options = { capture: true };
  let otherDocument: Document | null = null;
  const detach = () => {
    for (const type of OUTSIDE_EVENTS) otherDocument?.removeEventListener(type, onDismiss, options);
    otherDocument = null;
  };
  const attach = (target: Document | null) => {
    detach();
    if (!target || target === owner) return;
    otherDocument = target;
    // Capture runs even when a control in the other surface stops propagation.
    // Keyboard/assistive activation produces click without pointerdown.
    for (const type of OUTSIDE_EVENTS) target.addEventListener(type, onDismiss, options);
  };
  try {
    const view = owner.defaultView;
    if (view && view.parent !== view) {
      // frameElement belongs to the parent realm: do not use instanceof here.
      const frame = view.frameElement;
      if (!frame?.matches(EDITOR_FRAME_SELECTOR)) return detach;
      const onShow = () => attach(frame.ownerDocument);
      onShow();
      // React effects need not unmount when an iframe navigates. The parent
      // document would otherwise retain callbacks from the discarded editor.
      view.addEventListener('pagehide', detach);
      view.addEventListener('pageshow', onShow);
      return () => {
        view.removeEventListener('pagehide', detach);
        view.removeEventListener('pageshow', onShow);
        detach();
      };
    }
    const frame = owner.querySelector<HTMLIFrameElement>(EDITOR_FRAME_SELECTOR);
    if (!frame) return detach;
    const onLoad = () => {
      try {
        attach(frame.contentDocument);
      } catch {
        detach(); // Cross-origin/unavailable documents are never inspected.
      }
    };
    frame.addEventListener('load', onLoad);
    onLoad();
    return () => {
      frame.removeEventListener('load', onLoad);
      detach();
    };
  } catch {
    detach();
    return detach;
  }
}

export function useHostedSurfaceDismiss(onDismiss: () => void, enabled: boolean) {
  useEffect(() => {
    if (enabled) return subscribeToOtherHostedSurface(document, onDismiss);
  }, [enabled, onDismiss]);
}
