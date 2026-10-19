import { useCallback, useEffect, useState, type RefObject } from 'react';

const MODAL_SELECTOR = '[aria-modal="true"], dialog:modal';

function editorDocument(iframe: HTMLIFrameElement | null): Document | null {
  // The hosted editor is same-origin. A navigating/unavailable frame has no modal yet.
  try {
    return iframe?.contentDocument ?? null;
  } catch {
    return null;
  }
}

function isVisible(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  return Boolean(
    view &&
      !element.closest('[hidden]') &&
      element.getClientRects().length > 0 &&
      view.getComputedStyle(element).visibility !== 'hidden',
  );
}

function hasVisibleModal(document: Document | null): boolean {
  return [...(document?.querySelectorAll<HTMLElement>(MODAL_SELECTOR) ?? [])].some(isVisible);
}

/** Dashboard and editor modals share a resize lock, not a focus or input lock. */
export function useDashboardModalGuard(iframeRef: RefObject<HTMLIFrameElement>) {
  const isModalOpen = useCallback(() => {
    if (hasVisibleModal(document)) return true;
    const iframe = iframeRef.current;
    return Boolean(
      iframe &&
        hasVisibleModal(editorDocument(iframe)) &&
        isVisible(iframe) &&
        iframe.ownerDocument.defaultView?.getComputedStyle(iframe).opacity !== '0',
    );
  }, [iframeRef]);
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    const sync = () => setModalOpen(isModalOpen());
    const containsObservedTarget = (node: Node) => {
      if (node.nodeType !== 1) return false;
      const element = node as Element;
      return (
        element.matches(MODAL_SELECTOR) ||
        Boolean(element.querySelector(MODAL_SELECTOR)) ||
        element.contains(iframeRef.current)
      );
    };
    const observe = (document: Document | null) => {
      if (!document?.body) return undefined;
      const observer = new MutationObserver((records) => {
        // Graph outputs and tree updates are frequent. Ignore changes unrelated to dialogs.
        if (
          records.some((record) =>
            record.type === 'attributes'
              ? record.attributeName === 'aria-modal' ||
                record.attributeName === 'open' ||
                containsObservedTarget(record.target)
              : [...record.addedNodes, ...record.removedNodes].some(containsObservedTarget),
          )
        )
          sync();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-modal', 'open', 'hidden', 'style', 'class'],
      });
      return observer;
    };
    const dashboardObserver = observe(document);
    let editorObserver: MutationObserver | undefined;
    const attachEditor = () => {
      editorObserver?.disconnect();
      editorObserver = observe(editorDocument(iframeRef.current));
      sync();
    };
    const iframe = iframeRef.current;
    iframe?.addEventListener('load', attachEditor);
    attachEditor();
    return () => {
      dashboardObserver?.disconnect();
      editorObserver?.disconnect();
      iframe?.removeEventListener('load', attachEditor);
    };
  }, [iframeRef, isModalOpen]);
  return { modalOpen, isModalOpen };
}
