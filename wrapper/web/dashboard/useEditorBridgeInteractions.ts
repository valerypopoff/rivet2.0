import { useEffect } from 'react';

import type { EditorShortcutModifier } from '../../shared/editor-bridge';
import {
  focusHostedEditorCanvas,
  focusHostedEditorFrame,
  isEditorFindShortcutEvent,
  isEditableElement,
} from './editorBridgeFocus';

const MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS = [
  '[data-testid="fullscreen-output-modal"] .search-input',
  '.context-menu-search input[placeholder="Search..."]:not(:disabled)',
  '.plugin-search input[placeholder="Search..."]',
  '.search input[placeholder="Search..."]',
];

function isVisibleEnabledInput(input: HTMLInputElement): boolean {
  return !input.disabled && input.getClientRects().length > 0;
}

function isMountedEditorSearchInput(element: Element | null | undefined): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS.some((selector) => element.matches(selector)) &&
    isVisibleEnabledInput(element)
  );
}

function focusMountedEditorSearchInput(): boolean {
  for (const selector of MOUNTED_EDITOR_SEARCH_INPUT_SELECTORS) {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input || !isVisibleEnabledInput(input)) {
      continue;
    }

    input.focus({ preventScroll: true });
    input.select();
    return true;
  }

  return false;
}

function createEditorKeyboardEvent(
  modifier: EditorShortcutModifier,
  key: 'd' | 'f',
): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: key === 'd' ? 'KeyD' : 'KeyF',
    ctrlKey: modifier === 'ctrl',
    key,
    metaKey: modifier === 'meta',
  });
}

export function replayEditorFindShortcut(modifier: EditorShortcutModifier): void {
  window.dispatchEvent(createEditorKeyboardEvent(modifier, 'f'));
}

export function replayEditorDuplicateShortcut(modifier: EditorShortcutModifier): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  (target ?? window).dispatchEvent(createEditorKeyboardEvent(modifier, 'd'));
}

export function useEditorBridgeInteractions({
  canOpenGraphSearch,
  onOpenGraphSearch,
}: {
  canOpenGraphSearch: boolean;
  onOpenGraphSearch: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isEditorFindShortcutEvent(event)) {
        return;
      }

      const targetElement = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement;
      const shortcutStartedInEditorSearch = (
        isMountedEditorSearchInput(targetElement) || isMountedEditorSearchInput(activeElement)
      );
      if (!shortcutStartedInEditorSearch && (isEditableElement(targetElement) || isEditableElement(activeElement))) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      if (focusMountedEditorSearchInput()) {
        return;
      }

      if (canOpenGraphSearch) {
        onOpenGraphSearch();
      }
    };

    window.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', handler, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', handler, true);
    };
  }, [canOpenGraphSearch, onOpenGraphSearch]);

  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.node-canvas')) {
        return;
      }

      focusHostedEditorFrame();
      focusHostedEditorCanvas(event.target);
    };

    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, []);
}
