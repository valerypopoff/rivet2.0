import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
import EditIcon from 'majesticons/line/edit-pen-2-line.svg?react';
import Button from '@atlaskit/button';
import { Global, css } from '@emotion/react';
import { useAtom } from 'jotai';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { monaco } from '../../utils/monaco.js';
import { copyToClipboard } from '../../utils/copyToClipboard.js';
import {
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  type JsonStringEditModalSize,
  MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  jsonStringEditModalSizeState,
  jsonStringPreviewPopoverMaxHeightState,
  jsonStringPreviewPopoverWidthState,
} from '../../state/ui.js';
import {
  findJsonStringPreviewRangeAtPosition,
  getJsonStringPreviewRanges,
  type JsonStringPreviewRange,
} from './jsonStringPreviewRanges.js';

const POPOVER_HEADER_ESTIMATED_HEIGHT = 43;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 12;
const MIN_VISIBLE_POPOVER_BODY_HEIGHT = 48;
const POPOVER_RESIZE_KEYBOARD_STEP = 20;
const EDIT_MODAL_VIEWPORT_GAP = 24;
const EDIT_MODAL_RESIZE_HITBOX = 28;
const MIN_JSON_STRING_EDIT_MODAL_WIDTH = 560;
const MIN_JSON_STRING_EDIT_MODAL_HEIGHT = 520;
const BUTTON_VIEWPORT_WIDTH = 30;
const BUTTON_VIEWPORT_HEIGHT = 20;
const BUTTON_ANCHOR_OFFSET_X = 4;
const BUTTON_ANCHOR_OFFSET_Y = 1;

const jsonStringPreviewAffordanceStyles = css`
  .json-string-preview-button {
    align-items: center;
    background: color-mix(in srgb, var(--modal-surface-bg) 86%, var(--primary) 14%);
    border: 1px solid var(--foldable-section-border);
    border-radius: 4px;
    color: var(--grey-lightest);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-family);
    font-size: 10px;
    font-weight: 700;
    height: 18px;
    justify-content: center;
    opacity: 0.78;
    padding: 0 4px;
    pointer-events: auto;
    position: fixed;
    touch-action: none;
    z-index: 4000;
  }

  .json-string-preview-button-local {
    position: absolute;
  }

  .json-string-preview-button:hover,
  .json-string-preview-button:focus-visible {
    border-color: var(--primary);
    color: var(--primary);
    opacity: 1;
    outline: none;
  }

  .json-string-preview-popover {
    background: var(--modal-surface-bg);
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
    color: var(--grey-lightest);
    max-width: calc(100vw - 24px);
    min-width: 260px;
    position: fixed;
    z-index: 4000;
  }

  .json-string-preview-popover-header {
    align-items: center;
    border-bottom: 1px solid var(--foldable-section-border);
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 10px 14px;
  }

  .json-string-preview-popover-header > span {
    color: var(--grey-light);
    flex: 1;
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    min-width: 0;
  }

  .json-string-preview-action-button {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--grey-light);
    cursor: pointer;
    display: inline-flex;
    font-size: var(--ui-font-size-sm);
    gap: 4px;
    padding: 2px 4px;
  }

  .json-string-preview-action-button:hover,
  .json-string-preview-action-button:focus-visible {
    color: var(--primary);
    outline: none;
  }

  .json-string-preview-action-button svg {
    height: 14px;
    width: 14px;
  }

  .json-string-preview-popover pre {
    color: var(--grey-lightest);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    margin: 0;
    overflow: auto;
    padding: 14px 16px 20px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-string-preview-resize-handle {
    background: transparent;
    border: 0;
    bottom: 0;
    cursor: nesw-resize;
    height: 18px;
    left: 0;
    padding: 0;
    position: absolute;
    width: 18px;
  }

  .json-string-preview-resize-handle::before,
  .json-string-preview-resize-handle::after {
    border-bottom: 2px solid color-mix(in srgb, var(--primary) 70%, transparent);
    border-left: 2px solid color-mix(in srgb, var(--primary) 70%, transparent);
    content: '';
    opacity: 0.42;
    position: absolute;
    transition: opacity 120ms ease-out;
  }

  .json-string-preview-resize-handle::before {
    bottom: 4px;
    height: 8px;
    left: 4px;
    width: 8px;
  }

  .json-string-preview-resize-handle::after {
    bottom: 8px;
    height: 4px;
    left: 8px;
    width: 4px;
  }

  .json-string-preview-resize-handle:hover::before,
  .json-string-preview-resize-handle:hover::after,
  .json-string-preview-resize-handle:focus-visible::before,
  .json-string-preview-resize-handle:focus-visible::after {
    opacity: 0.9;
  }

  .json-string-preview-resize-handle:focus-visible {
    outline: none;
  }

  .json-string-edit-modal-backdrop {
    align-items: center;
    background: color-mix(in srgb, var(--grey-dark) 64%, transparent);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 12px;
    position: fixed;
    z-index: 4100;
  }

  .json-string-edit-modal {
    background: var(--modal-surface-bg);
    border: 1px solid var(--foldable-section-border);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.38);
    color: var(--grey-lightest);
    display: grid;
    gap: 14px;
    grid-template-rows: auto minmax(320px, 1fr) auto;
    max-height: calc(100vh - 24px);
    max-width: calc(100vw - 24px);
    min-width: min(560px, calc(100vw - 24px));
    overflow: auto;
    padding: 22px;
    resize: both;
    width: min(960px, calc(100vw - 24px));
  }

  .json-string-edit-modal-header {
    display: grid;
    gap: 6px;
  }

  .json-string-edit-modal h2 {
    font-size: var(--ui-font-size-lg);
    line-height: 1.25;
    margin: 0;
  }

  .json-string-edit-modal textarea {
    background: var(--form-control-bg);
    border: 1px solid var(--form-control-border);
    border-radius: 8px;
    color: var(--foreground);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-base);
    height: 100%;
    line-height: 1.45;
    min-height: 0;
    padding: 12px 14px;
    resize: none;
    width: 100%;
  }

  .json-string-edit-modal textarea:focus {
    background: var(--form-control-bg);
    border-color: var(--form-control-border);
    outline: none;
  }

  .json-string-edit-modal-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }

  .json-string-edit-secondary-button {
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: 8px 14px;
  }

  .json-string-edit-secondary-button {
    background: transparent;
    border: 1px solid var(--foldable-section-border);
    color: var(--foreground);
  }

  .json-string-edit-primary-button {
    min-width: calc(84px * var(--ui-font-scale));
  }

  .json-string-edit-secondary-button:hover,
  .json-string-edit-secondary-button:focus-visible {
    outline: none;
  }

`;

type JsonStringPreviewAffordanceProps = {
  buttonCoordinateMode?: 'root' | 'viewport';
  editor?: monaco.editor.IStandaloneCodeEditor;
  enabled: boolean;
  minDecodedLength?: number;
  onEditString?(range: JsonStringPreviewRange, decodedValue: string): void;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  text: string;
};

type EditModalState = {
  draft: string;
  range: JsonStringPreviewRange;
};

type PopoverState = {
  left: number;
  range: JsonStringPreviewRange;
  top: number;
};

type ButtonState = {
  left: number;
  range: JsonStringPreviewRange;
  top: number;
};

type ButtonViewportRect = {
  bottom: number;
  left: number;
};

export const JsonStringPreviewAffordance: FC<JsonStringPreviewAffordanceProps> = ({
  buttonCoordinateMode = 'viewport',
  editor,
  enabled,
  minDecodedLength,
  onEditString,
  rootRef,
  text,
}) => {
  const [savedPopoverWidth, setSavedPopoverWidth] = useAtom(jsonStringPreviewPopoverWidthState);
  const [savedPopoverMaxHeight, setSavedPopoverMaxHeight] = useAtom(jsonStringPreviewPopoverMaxHeightState);
  const [savedEditModalSize, setSavedEditModalSize] = useAtom(jsonStringEditModalSizeState);
  const ranges = useMemo(
    () => (enabled ? getJsonStringPreviewRanges(text, { minDecodedLength }) : []),
    [enabled, minDecodedLength, text],
  );
  const rangesRef = useRef(ranges);
  const activeRangeRef = useRef<JsonStringPreviewRange | null>(null);
  const buttonRangeRef = useRef<JsonStringPreviewRange | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const buttonStateRef = useRef<ButtonState | null>(null);
  const decodedTextRef = useRef<HTMLPreElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const editModalRef = useRef<HTMLDivElement | null>(null);
  const editModalResizeActiveRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const buttonKeepsPreviewRef = useRef(false);
  const popoverOpenRef = useRef(false);
  const popoverStateRef = useRef<PopoverState | null>(null);
  const [livePopoverWidth, setLivePopoverWidth] = useState<number | null>(null);
  const [livePopoverMaxHeight, setLivePopoverMaxHeight] = useState<number | null>(null);
  const [buttonState, setButtonState] = useState<ButtonState | null>(null);
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const editTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const popoverRangeId = popover?.range.id;
  const editModalRangeId = editModal?.range.id;
  const popoverWidth = livePopoverWidth ?? clampJsonStringPreviewPopoverWidth(savedPopoverWidth);
  const popoverMaxHeight = livePopoverMaxHeight ?? clampJsonStringPreviewPopoverMaxHeight(savedPopoverMaxHeight);
  const visiblePopoverWidth = getVisibleJsonStringPreviewPopoverWidth(
    popoverWidth,
    popover?.left,
    buttonRef.current?.ownerDocument.defaultView,
  );
  const visiblePopoverMaxHeight = getVisibleJsonStringPreviewPopoverMaxHeight(
    popoverMaxHeight,
    popover?.top,
    buttonRef.current?.ownerDocument.defaultView,
  );
  const visibleEditModalSize = getVisibleJsonStringEditModalSize(
    savedEditModalSize,
    editTextAreaRef.current?.ownerDocument.defaultView ??
      rootRef.current?.ownerDocument.defaultView ??
      buttonRef.current?.ownerDocument.defaultView,
  );

  rangesRef.current = ranges;
  buttonStateRef.current = buttonState;
  popoverOpenRef.current = popover != null;
  popoverStateRef.current = popover;

  const getButtonStateForRange = useCallback(
    (range: JsonStringPreviewRange): ButtonState | undefined => {
      const model = editor?.getModel();
      const editorElement = editor?.getDomNode();
      const rootElement = rootRef.current;

      if (!model || !editor || !editorElement) {
        return undefined;
      }

      const anchorPosition = model.getPositionAt(range.endOffset);
      const visiblePosition = editor.getScrolledVisiblePosition(anchorPosition);

      if (!visiblePosition) {
        return undefined;
      }

      if (!doesScrolledPositionFitPreviewButton(visiblePosition, editor)) {
        return undefined;
      }

      const editorRect = editorElement.getBoundingClientRect();
      const coordinateMode = buttonCoordinateMode;

      if (coordinateMode === 'root' && !rootElement) {
        return undefined;
      }

      const rootRect = coordinateMode === 'root' ? rootElement?.getBoundingClientRect() : undefined;

      return {
        left: editorRect.left + visiblePosition.left - (rootRect?.left ?? 0) + BUTTON_ANCHOR_OFFSET_X,
        range,
        top: editorRect.top + visiblePosition.top - (rootRect?.top ?? 0) + BUTTON_ANCHOR_OFFSET_Y,
      };
    },
    [buttonCoordinateMode, editor, rootRef],
  );

  const setVisibleButtonState = useCallback((nextButtonState: ButtonState | null) => {
    setButtonState((currentButtonState) => {
      if (
        currentButtonState?.range.id === nextButtonState?.range.id &&
        currentButtonState?.left === nextButtonState?.left &&
        currentButtonState?.top === nextButtonState?.top
      ) {
        return currentButtonState;
      }

      return nextButtonState;
    });
  }, []);

  const clearPreviewAffordance = useCallback(() => {
    popoverOpenRef.current = false;
    buttonKeepsPreviewRef.current = false;
    editModalResizeActiveRef.current = false;
    activeRangeRef.current = null;
    buttonRangeRef.current = null;
    setVisibleButtonState(null);
    setPopover(null);
    setEditModal(null);
  }, [setVisibleButtonState]);

  const hideButton = useCallback(() => {
    if (popoverOpenRef.current || buttonKeepsPreviewRef.current) {
      return;
    }

    clearPreviewAffordance();
  }, [clearPreviewAffordance]);

  const showButtonForRange = useCallback(
    (range: JsonStringPreviewRange | undefined, options: { clearUnavailable?: boolean } = {}) => {
      if (!range) {
        if (options.clearUnavailable === true) {
          clearPreviewAffordance();
        } else {
          hideButton();
        }
        return;
      }

      const nextButtonState = getButtonStateForRange(range);

      if (!nextButtonState) {
        if (options.clearUnavailable === true) {
          clearPreviewAffordance();
        } else {
          hideButton();
        }
        return;
      }

      activeRangeRef.current = range;
      buttonRangeRef.current = range;
      setVisibleButtonState(nextButtonState);
    },
    [clearPreviewAffordance, getButtonStateForRange, hideButton, setVisibleButtonState],
  );

  const getRangeAtPosition = useCallback(
    (position: monaco.IPosition | null | undefined) => {
      const model = editor?.getModel();

      if (!model || !position) {
        return undefined;
      }

      return findJsonStringPreviewRangeAtPosition(rangesRef.current, model.getOffsetAt(position), position.lineNumber);
    },
    [editor],
  );

  const getCursorRange = useCallback(() => {
    const position = editor?.getPosition();
    return getRangeAtPosition(position);
  }, [editor, getRangeAtPosition]);

  const getMouseEventPosition = useCallback(
    (event: monaco.editor.IEditorMouseEvent) => {
      if (event.target.position) {
        return event.target.position;
      }

      const { clientX, clientY } = event.event.browserEvent;
      return editor?.getTargetAtClientPoint(clientX, clientY)?.position ?? null;
    },
    [editor],
  );

  const getButtonViewportRect = useCallback(
    (button: ButtonState) => {
      const rootElement = rootRef.current;
      const rootRect = buttonCoordinateMode === 'root' ? rootElement?.getBoundingClientRect() : undefined;

      if (buttonCoordinateMode === 'root' && !rootRect) {
        return undefined;
      }

      const left = (rootRect?.left ?? 0) + button.left;
      const top = (rootRect?.top ?? 0) + button.top;

      return {
        bottom: top + BUTTON_VIEWPORT_HEIGHT,
        left,
      };
    },
    [buttonCoordinateMode, rootRef],
  );

  const calculatePopoverPosition = useCallback(
    (buttonRect: ButtonViewportRect) => {
      const ownerWindow =
        buttonRef.current?.ownerDocument.defaultView ??
        rootRef.current?.ownerDocument.defaultView ??
        editor?.getDomNode()?.ownerDocument.defaultView ??
        window;
      const viewportWidth = ownerWindow.innerWidth;
      const viewportHeight = ownerWindow.innerHeight;
      const effectiveWidth = Math.min(
        popoverWidth,
        Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, viewportWidth - 24),
      );
      const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - effectiveWidth - VIEWPORT_PADDING);
      const left = Math.min(Math.max(buttonRect.left, VIEWPORT_PADDING), maxLeft);
      const top = buttonRect.bottom + POPOVER_GAP;
      const maxTop = Math.max(
        VIEWPORT_PADDING,
        viewportHeight - VIEWPORT_PADDING - POPOVER_HEADER_ESTIMATED_HEIGHT - MIN_VISIBLE_POPOVER_BODY_HEIGHT,
      );

      return {
        left,
        top: Math.max(VIEWPORT_PADDING, Math.min(top, maxTop)),
      };
    },
    [editor, popoverWidth, rootRef],
  );

  const showResolvedButtonState = useCallback(
    (nextButtonState: ButtonState) => {
      activeRangeRef.current = nextButtonState.range;
      buttonRangeRef.current = nextButtonState.range;
      setVisibleButtonState(nextButtonState);
    },
    [setVisibleButtonState],
  );

  const repositionPopoverForRange = useCallback(
    (range: JsonStringPreviewRange) => {
      const nextButtonState = getButtonStateForRange(range);

      if (!nextButtonState) {
        clearPreviewAffordance();
        return undefined;
      }

      const nextButtonRect = getButtonViewportRect(nextButtonState);

      if (!nextButtonRect) {
        clearPreviewAffordance();
        return undefined;
      }

      const nextPosition = calculatePopoverPosition(nextButtonRect);

      if (!nextPosition) {
        clearPreviewAffordance();
        return undefined;
      }

      showResolvedButtonState(nextButtonState);
      setPopover((currentPopover) => (currentPopover ? { ...currentPopover, ...nextPosition } : currentPopover));
      return nextPosition;
    },
    [
      calculatePopoverPosition,
      clearPreviewAffordance,
      getButtonStateForRange,
      getButtonViewportRect,
      showResolvedButtonState,
    ],
  );

  const closePopover = useCallback(
    (restoreButtonFocus = false) => {
      popoverOpenRef.current = false;
      setPopover(null);

      if (restoreButtonFocus) {
        buttonKeepsPreviewRef.current = true;
        requestAnimationFrame(() => buttonRef.current?.focus());
        return;
      }

      hideButton();
    },
    [hideButton],
  );

  const openPopover = useCallback(() => {
    if (popoverOpenRef.current) {
      return;
    }

    const range = buttonStateRef.current?.range ?? activeRangeRef.current ?? buttonRangeRef.current;

    if (!range) {
      return;
    }

    const nextButtonState = getButtonStateForRange(range);

    if (!nextButtonState) {
      return;
    }

    const buttonRect = getButtonViewportRect(nextButtonState);

    if (!buttonRect) {
      return;
    }

    const position = calculatePopoverPosition(buttonRect);

    if (!position) {
      return;
    }

    showResolvedButtonState(nextButtonState);

    popoverOpenRef.current = true;
    setPopover({ range, ...position });
  }, [calculatePopoverPosition, getButtonStateForRange, getButtonViewportRect, showResolvedButtonState]);

  const setPopoverWidth = useCallback(
    (width: number) => {
      const nextWidth = clampJsonStringPreviewPopoverWidth(width);
      setLivePopoverWidth(null);
      setSavedPopoverWidth(nextWidth);
    },
    [setSavedPopoverWidth],
  );

  const keepRightEdgeWhileResizingWidth = useCallback((requestedWidth: number, rightEdge: number) => {
    const nextWidth = getLeftResizePopoverWidth(requestedWidth, rightEdge);
    setPopover((currentPopover) =>
      currentPopover ? { ...currentPopover, left: rightEdge - nextWidth } : currentPopover,
    );
    return nextWidth;
  }, []);

  const setPopoverMaxHeight = useCallback(
    (maxHeight: number) => {
      const nextMaxHeight = clampJsonStringPreviewPopoverMaxHeight(maxHeight);
      setLivePopoverMaxHeight(null);
      setSavedPopoverMaxHeight(nextMaxHeight);
    },
    [setSavedPopoverMaxHeight],
  );

  const cleanupResizeListeners = useCallback(() => {
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = null;
  }, []);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      cleanupResizeListeners();

      const ownerWindow = event.currentTarget.ownerDocument.defaultView ?? window;
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = visiblePopoverWidth;
      const startMaxHeight = getPopoverResizeStartMaxHeight(decodedTextRef.current, popoverMaxHeight);
      const rightEdge = (popover?.left ?? 0) + startWidth;

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        pointerEvent.preventDefault();
        setLivePopoverWidth(keepRightEdgeWhileResizingWidth(startWidth - (pointerEvent.clientX - startX), rightEdge));
        setLivePopoverMaxHeight(clampJsonStringPreviewPopoverMaxHeight(startMaxHeight + pointerEvent.clientY - startY));
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        const finalWidth = keepRightEdgeWhileResizingWidth(startWidth - (pointerEvent.clientX - startX), rightEdge);
        const finalMaxHeight = clampJsonStringPreviewPopoverMaxHeight(startMaxHeight + pointerEvent.clientY - startY);
        setLivePopoverWidth(null);
        setLivePopoverMaxHeight(null);
        setSavedPopoverWidth(finalWidth);
        setSavedPopoverMaxHeight(finalMaxHeight);
        cleanupResizeListeners();
      };

      resizeCleanupRef.current = () => {
        ownerWindow.removeEventListener('pointermove', handlePointerMove, true);
        ownerWindow.removeEventListener('pointerup', handlePointerUp, true);
        ownerWindow.removeEventListener('pointercancel', handlePointerUp, true);
      };
      ownerWindow.addEventListener('pointermove', handlePointerMove, true);
      ownerWindow.addEventListener('pointerup', handlePointerUp, true);
      ownerWindow.addEventListener('pointercancel', handlePointerUp, true);
    },
    [
      cleanupResizeListeners,
      keepRightEdgeWhileResizingWidth,
      popover?.left,
      popoverMaxHeight,
      setSavedPopoverMaxHeight,
      setSavedPopoverWidth,
      visiblePopoverWidth,
    ],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const currentResizeMaxHeight = getPopoverResizeStartMaxHeight(decodedTextRef.current, popoverMaxHeight);
      let nextMaxHeight: number | undefined;
      let nextWidth: number | undefined;

      switch (event.key) {
        case 'ArrowLeft':
          nextWidth = popoverWidth + POPOVER_RESIZE_KEYBOARD_STEP;
          break;
        case 'ArrowRight':
          nextWidth = popoverWidth - POPOVER_RESIZE_KEYBOARD_STEP;
          break;
        case 'ArrowUp':
          nextMaxHeight = currentResizeMaxHeight - POPOVER_RESIZE_KEYBOARD_STEP;
          break;
        case 'ArrowDown':
          nextMaxHeight = currentResizeMaxHeight + POPOVER_RESIZE_KEYBOARD_STEP;
          break;
        case 'Home':
          nextWidth = MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH;
          nextMaxHeight = MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT;
          break;
        case 'End':
          nextWidth = MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH;
          nextMaxHeight = MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT;
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (nextWidth != null) {
        const rightEdge = (popover?.left ?? 0) + visiblePopoverWidth;
        setPopoverWidth(keepRightEdgeWhileResizingWidth(nextWidth, rightEdge));
      }
      if (nextMaxHeight != null) {
        setPopoverMaxHeight(nextMaxHeight);
      }
    },
    [
      keepRightEdgeWhileResizingWidth,
      popover?.left,
      popoverMaxHeight,
      popoverWidth,
      setPopoverMaxHeight,
      setPopoverWidth,
      visiblePopoverWidth,
    ],
  );

  const openEditModal = useCallback(
    (range: JsonStringPreviewRange) => {
      activeRangeRef.current = null;
      buttonRangeRef.current = null;
      popoverOpenRef.current = false;
      setVisibleButtonState(null);
      setPopover(null);
      setEditModal({ range, draft: range.decodedValue });
    },
    [setVisibleButtonState],
  );

  const closeEditModal = useCallback(() => {
    clearPreviewAffordance();
  }, [clearPreviewAffordance]);

  const saveEditModal = useCallback(() => {
    if (!editModal || !onEditString) {
      return;
    }

    onEditString(editModal.range, editModal.draft);
    clearPreviewAffordance();
  }, [clearPreviewAffordance, editModal, onEditString]);

  const handleEditModalPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modal = editModalRef.current;

    if (!modal) {
      return;
    }

    const rect = modal.getBoundingClientRect();
    const isResizeCorner =
      event.clientX >= rect.right - EDIT_MODAL_RESIZE_HITBOX &&
      event.clientY >= rect.bottom - EDIT_MODAL_RESIZE_HITBOX;

    if (!isResizeCorner) {
      return;
    }

    const modalWindow = modal.ownerDocument.defaultView ?? window;
    editModalResizeActiveRef.current = true;

    const clearResizeActive = () => {
      modalWindow.removeEventListener('pointerup', clearResizeActive, true);
      modalWindow.removeEventListener('pointercancel', clearResizeActive, true);
      modalWindow.requestAnimationFrame(() => {
        modalWindow.requestAnimationFrame(() => {
          editModalResizeActiveRef.current = false;
        });
      });
    };

    modalWindow.addEventListener('pointerup', clearResizeActive, true);
    modalWindow.addEventListener('pointercancel', clearResizeActive, true);
  }, []);

  useLayoutEffect(() => {
    if (!enabled || !editor || ranges.length === 0) {
      clearPreviewAffordance();
      return;
    }

    const handleRootMouseLeave = (event: MouseEvent) => {
      const relatedTarget = event.relatedTarget;
      const ownerWindow = rootRef.current?.ownerDocument.defaultView ?? window;

      if (
        relatedTarget instanceof ownerWindow.Node &&
        (buttonRef.current?.contains(relatedTarget) || popoverRef.current?.contains(relatedTarget))
      ) {
        return;
      }

      const cursorRange = editor.hasTextFocus() ? getCursorRange() : undefined;

      if (cursorRange) {
        showButtonForRange(cursorRange);
        return;
      }

      hideButton();
    };
    const repositionActiveButton = () => {
      const activeRange = activeRangeRef.current;

      if (activeRange) {
        showButtonForRange(activeRange, { clearUnavailable: true });
      }
    };

    const mouseMoveDisposable = editor.onMouseMove((event) => {
      const target = event.event.browserEvent.target;
      const ownerWindow = buttonRef.current?.ownerDocument.defaultView ?? window;

      if (target instanceof ownerWindow.Node && buttonRef.current?.contains(target)) {
        return;
      }

      const position = getMouseEventPosition(event);
      showButtonForRange(getRangeAtPosition(position));
    });
    const mouseDownDisposable = editor.onMouseDown((event) => {
      const position = getMouseEventPosition(event);
      showButtonForRange(getRangeAtPosition(position));
    });
    const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
      showButtonForRange(getRangeAtPosition(event.position));
    });
    const focusDisposable = editor.onDidFocusEditorText(() => {
      const position = editor.getPosition();
      showButtonForRange(getRangeAtPosition(position));
    });
    const scrollDisposable = editor.onDidScrollChange(repositionActiveButton);
    const layoutDisposable = editor.onDidLayoutChange(repositionActiveButton);
    const rootElement = rootRef.current;
    const ownerWindow = editor.getDomNode()?.ownerDocument.defaultView ?? window;
    rootElement?.addEventListener('mouseleave', handleRootMouseLeave);
    ownerWindow.addEventListener('resize', repositionActiveButton);
    ownerWindow.addEventListener('scroll', repositionActiveButton, true);
    showButtonForRange(getCursorRange());

    return () => {
      rootElement?.removeEventListener('mouseleave', handleRootMouseLeave);
      ownerWindow.removeEventListener('resize', repositionActiveButton);
      ownerWindow.removeEventListener('scroll', repositionActiveButton, true);
      mouseMoveDisposable.dispose();
      mouseDownDisposable.dispose();
      cursorDisposable.dispose();
      focusDisposable.dispose();
      scrollDisposable.dispose();
      layoutDisposable.dispose();
      clearPreviewAffordance();
      buttonKeepsPreviewRef.current = false;
    };
  }, [
    clearPreviewAffordance,
    editor,
    enabled,
    getCursorRange,
    getMouseEventPosition,
    getRangeAtPosition,
    hideButton,
    ranges.length,
    rootRef,
    setVisibleButtonState,
    showButtonForRange,
  ]);

  useEffect(() => {
    clearPreviewAffordance();
  }, [clearPreviewAffordance, text]);

  useEffect(() => cleanupResizeListeners, [cleanupResizeListeners]);

  useEffect(() => {
    if (!popoverRangeId) {
      return;
    }

    const popoverWindow = buttonRef.current?.ownerDocument.defaultView ?? window;
    const repositionPopover = () => {
      const currentPopover = popoverStateRef.current;

      if (!currentPopover) {
        return;
      }

      repositionPopoverForRange(currentPopover.range);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closePopover(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof popoverWindow.Node)) {
        closePopover();
        return;
      }

      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }

      closePopover();
    };

    popoverWindow.addEventListener('resize', repositionPopover);
    popoverWindow.addEventListener('scroll', repositionPopover, true);
    popoverWindow.addEventListener('keydown', handleKeyDown, true);
    popoverWindow.addEventListener('pointerdown', handlePointerDown, true);
    const scrollDisposable = editor?.onDidScrollChange(repositionPopover);
    const layoutDisposable = editor?.onDidLayoutChange(repositionPopover);

    return () => {
      popoverWindow.removeEventListener('resize', repositionPopover);
      popoverWindow.removeEventListener('scroll', repositionPopover, true);
      popoverWindow.removeEventListener('keydown', handleKeyDown, true);
      popoverWindow.removeEventListener('pointerdown', handlePointerDown, true);
      scrollDisposable?.dispose();
      layoutDisposable?.dispose();
    };
  }, [closePopover, editor, popoverRangeId, repositionPopoverForRange]);

  useEffect(() => {
    if (!editModalRangeId) {
      return;
    }

    const editWindow =
      editTextAreaRef.current?.ownerDocument.defaultView ??
      buttonRef.current?.ownerDocument.defaultView ??
      rootRef.current?.ownerDocument.defaultView ??
      window;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeEditModal();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        saveEditModal();
      }
    };

    editWindow.addEventListener('keydown', handleKeyDown, true);
    requestAnimationFrame(() => editTextAreaRef.current?.focus());

    return () => {
      editWindow.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeEditModal, editModalRangeId, rootRef, saveEditModal]);

  useEffect(() => {
    const modal = editModalRef.current;

    if (!editModalRangeId || !modal) {
      return;
    }

    const modalWindow = modal.ownerDocument.defaultView ?? window;

    if (typeof modalWindow.ResizeObserver !== 'function') {
      return;
    }

    let animationFrame: number | undefined;
    let hasObservedInitialSize = false;
    const observer = new modalWindow.ResizeObserver(() => {
      if (!hasObservedInitialSize) {
        hasObservedInitialSize = true;
        return;
      }

      if (!editModalResizeActiveRef.current) {
        return;
      }

      if (animationFrame != null) {
        modalWindow.cancelAnimationFrame(animationFrame);
      }

      animationFrame = modalWindow.requestAnimationFrame(() => {
        const rect = modal.getBoundingClientRect();
        const nextSize = getVisibleJsonStringEditModalSize(
          {
            height: rect.height,
            width: rect.width,
          },
          modalWindow,
        );

        setSavedEditModalSize((previousSize) =>
          previousSize.height === nextSize.height && previousSize.width === nextSize.width ? previousSize : nextSize,
        );
      });
    });

    observer.observe(modal);

    return () => {
      observer.disconnect();

      if (animationFrame != null) {
        modalWindow.cancelAnimationFrame(animationFrame);
      }
    };
  }, [editModalRangeId, setSavedEditModalSize]);

  if (!buttonState && !popover && !editModal) {
    return null;
  }

  const buttonElement = buttonState ? (
    <button
      type="button"
      ref={buttonRef}
      className={`json-string-preview-button ${
        buttonCoordinateMode === 'root' ? 'json-string-preview-button-local' : ''
      }`}
      title="Preview unescaped string"
      aria-label="Preview unescaped string"
      style={{ left: buttonState.left, top: buttonState.top }}
      onPointerDownCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openPopover();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openPopover();
      }}
      onMouseDownCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openPopover();
      }}
      onMouseEnter={() => {
        buttonKeepsPreviewRef.current = true;
      }}
      onPointerEnter={() => {
        buttonKeepsPreviewRef.current = true;
      }}
      onMouseLeave={() => {
        buttonKeepsPreviewRef.current = false;
        hideButton();
      }}
      onFocus={() => {
        buttonKeepsPreviewRef.current = true;
      }}
      onBlur={() => {
        buttonKeepsPreviewRef.current = false;
        hideButton();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && popoverOpenRef.current) {
          event.preventDefault();
          event.stopPropagation();
          closePopover(true);
          return;
        }

        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          openPopover();
        }
      }}
    >
      Aa
    </button>
  ) : null;
  const popoverElement = popover ? (
    <div
      ref={popoverRef}
      className="json-string-preview-popover"
      role="dialog"
      aria-modal="false"
      aria-label="Unescaped JSON string preview"
      style={{ left: popover.left, top: popover.top, width: visiblePopoverWidth }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="json-string-preview-popover-header">
        <span>Unescaped string</span>
        {onEditString && (
          <button
            type="button"
            className="json-string-preview-action-button"
            onClick={() => openEditModal(popover.range)}
          >
            <EditIcon />
            Edit
          </button>
        )}
        <button
          type="button"
          className="json-string-preview-action-button"
          onClick={() => void copyToClipboard(popover.range.decodedValue)}
        >
          <CopyIcon />
          Copy
        </button>
      </div>
      <pre ref={decodedTextRef} style={{ maxHeight: visiblePopoverMaxHeight }}>
        {popover.range.decodedValue}
      </pre>
      <button
        type="button"
        className="json-string-preview-resize-handle"
        aria-label="Resize preview"
        title="Resize preview"
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
    </div>
  ) : null;
  const editModalElement = editModal ? (
    <div
      className="json-string-edit-modal-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          closeEditModal();
        }
      }}
    >
      <div
        ref={editModalRef}
        className="json-string-edit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Edit unescaped JSON string"
        data-rivet-consume-run-hotkey="true"
        style={{ height: visibleEditModalSize.height, width: visibleEditModalSize.width }}
        onPointerDownCapture={handleEditModalPointerDownCapture}
      >
        <div className="json-string-edit-modal-header">
          <h2>Edit unescaped string</h2>
        </div>
        <textarea
          ref={editTextAreaRef}
          aria-label="Unescaped string value"
          value={editModal.draft}
          onChange={(event) => setEditModal((current) => (current ? { ...current, draft: event.target.value } : null))}
        />
        <div className="json-string-edit-modal-actions">
          <button type="button" className="json-string-edit-secondary-button" onClick={closeEditModal}>
            Cancel
          </button>
          <Button appearance="primary" className="json-string-edit-primary-button" onClick={saveEditModal}>
            Save
          </Button>
        </div>
      </div>
    </div>
  ) : null;
  const portalElement =
    buttonRef.current?.ownerDocument.body ??
    rootRef.current?.ownerDocument.body ??
    editor?.getDomNode()?.ownerDocument.body;

  return (
    <>
      <Global styles={jsonStringPreviewAffordanceStyles} />
      {buttonElement && buttonCoordinateMode === 'viewport' && portalElement
        ? createPortal(buttonElement, portalElement)
        : buttonElement}
      {popoverElement && portalElement ? createPortal(popoverElement, portalElement) : null}
      {editModalElement && portalElement ? createPortal(editModalElement, portalElement) : null}
    </>
  );
};

function clampJsonStringPreviewPopoverWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH;
  }

  return Math.min(
    MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH,
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, Math.round(value)),
  );
}

function getLeftResizePopoverWidth(width: number, rightEdge: number): number {
  return Math.min(
    clampJsonStringPreviewPopoverWidth(width),
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, rightEdge - VIEWPORT_PADDING),
  );
}

function clampJsonStringPreviewPopoverMaxHeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT;
  }

  return Math.min(
    MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT, Math.round(value)),
  );
}

function getVisibleJsonStringEditModalSize(
  size: JsonStringEditModalSize,
  ownerWindow?: Window | null,
): JsonStringEditModalSize {
  const targetWindow = ownerWindow ?? window;
  const maxWidth = Math.max(1, targetWindow.innerWidth - EDIT_MODAL_VIEWPORT_GAP);
  const maxHeight = Math.max(1, targetWindow.innerHeight - EDIT_MODAL_VIEWPORT_GAP);
  const minWidth = Math.min(MIN_JSON_STRING_EDIT_MODAL_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_JSON_STRING_EDIT_MODAL_HEIGHT, maxHeight);
  const width = typeof size.width === 'number' && Number.isFinite(size.width) ? size.width : minWidth;
  const height = typeof size.height === 'number' && Number.isFinite(size.height) ? size.height : minHeight;

  return {
    height: Math.min(maxHeight, Math.max(minHeight, Math.round(height))),
    width: Math.min(maxWidth, Math.max(minWidth, Math.round(width))),
  };
}

function getPopoverResizeStartMaxHeight(textElement: HTMLElement | null, fallbackMaxHeight: number): number {
  if (!textElement) {
    return fallbackMaxHeight;
  }

  const style = textElement.ownerDocument.defaultView?.getComputedStyle(textElement);
  const verticalPadding = Number.parseFloat(style?.paddingTop ?? '0') + Number.parseFloat(style?.paddingBottom ?? '0');
  const renderedContentHeight = textElement.getBoundingClientRect().height - verticalPadding;

  if (!Number.isFinite(renderedContentHeight) || renderedContentHeight <= 0) {
    return fallbackMaxHeight;
  }

  return clampJsonStringPreviewPopoverMaxHeight(
    Math.min(fallbackMaxHeight, Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT, renderedContentHeight)),
  );
}

function doesScrolledPositionFitPreviewButton(
  visiblePosition: { left: number; top: number; height: number },
  editor: monaco.editor.IStandaloneCodeEditor,
): boolean {
  const layoutInfo = editor.getLayoutInfo();
  const visibleBottom = visiblePosition.top + Math.max(1, visiblePosition.height);
  const buttonBottom = visiblePosition.top + BUTTON_VIEWPORT_HEIGHT;
  const buttonRight = visiblePosition.left + BUTTON_VIEWPORT_WIDTH;

  return (
    visibleBottom > 0 &&
    visiblePosition.top >= 0 &&
    buttonBottom <= layoutInfo.height &&
    visiblePosition.left >= 0 &&
    buttonRight <= layoutInfo.width
  );
}

function getVisibleJsonStringPreviewPopoverWidth(width: number, left?: number, ownerWindow?: Window | null): number {
  const clampedWidth = clampJsonStringPreviewPopoverWidth(width);
  const targetWindow = ownerWindow ?? window;

  if (left == null) {
    return clampedWidth;
  }

  return Math.min(
    clampedWidth,
    Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, targetWindow.innerWidth - left - VIEWPORT_PADDING),
  );
}

function getVisibleJsonStringPreviewPopoverMaxHeight(
  maxHeight: number,
  top?: number,
  ownerWindow?: Window | null,
): number {
  const clampedMaxHeight = clampJsonStringPreviewPopoverMaxHeight(maxHeight);
  const targetWindow = ownerWindow ?? window;

  if (top == null) {
    return clampedMaxHeight;
  }

  const availableHeight = targetWindow.innerHeight - top - POPOVER_HEADER_ESTIMATED_HEIGHT - VIEWPORT_PADDING;

  return Math.min(clampedMaxHeight, Math.max(MIN_VISIBLE_POPOVER_BODY_HEIGHT, availableHeight));
}
