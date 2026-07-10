import { Global } from '@emotion/react';
import { useAtom } from 'jotai';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { monaco } from '../../utils/monaco.js';
import {
  clampJsonStringPreviewPopoverMaxHeight,
  clampJsonStringPreviewPopoverWidth,
  MAX_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  MIN_JSON_STRING_PREVIEW_POPOVER_MAX_HEIGHT,
  MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  jsonStringEditModalSizeState,
  jsonStringPreviewPopoverMaxHeightState,
  jsonStringPreviewPopoverWidthState,
} from '../../state/editorPreferences.js';
import {
  findJsonStringPreviewRangeAtPosition,
  getJsonStringPreviewRanges,
  type JsonStringPreviewRange,
} from './jsonStringPreviewRanges.js';
import { jsonStringPreviewAffordanceStyles } from './jsonStringPreview/styles.js';
import {
  calculateJsonStringPreviewPopoverPosition,
  getLeftResizePopoverWidth,
  getVisibleJsonStringEditModalSize,
  getVisibleJsonStringPreviewPopoverMaxHeight,
  getVisibleJsonStringPreviewPopoverWidth,
  type JsonStringPreviewAnchorRect,
} from './jsonStringPreview/geometry.js';
import {
  getJsonStringPreviewButtonPlacement,
  getJsonStringPreviewRangeAtMouseEvent,
  type JsonStringPreviewButtonCoordinateMode,
  type JsonStringPreviewButtonPlacement,
} from './jsonStringPreview/monacoAdapter.js';
import {
  EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE,
  reduceJsonStringPreviewInteraction,
  type JsonStringPreviewCloseReason,
  type JsonStringPreviewInteractionState,
} from './jsonStringPreview/interactionState.js';
import { EditJsonStringModal, JsonStringPreviewButton, JsonStringPreviewPopover } from './jsonStringPreview/views.js';

const POPOVER_RESIZE_KEYBOARD_STEP = 20;
const EDIT_MODAL_RESIZE_HITBOX = 28;

type JsonStringPreviewAffordanceProps = {
  buttonCoordinateMode?: JsonStringPreviewButtonCoordinateMode;
  editor?: monaco.editor.IStandaloneCodeEditor;
  enabled: boolean;
  minDecodedLength?: number;
  onEditString?(range: JsonStringPreviewRange, decodedValue: string): void;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  text: string;
};

type ButtonState = JsonStringPreviewButtonPlacement;
type PopoverState = NonNullable<JsonStringPreviewInteractionState['popover']>;

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
  const [interaction, dispatchInteraction] = useReducer(
    reduceJsonStringPreviewInteraction,
    EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE,
  );
  const { button: buttonState, editModal, popover } = interaction;
  const editTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const popoverRangeId = popover?.range.id;
  const editModalRangeId = editModal?.range.id;
  const popoverWidth = livePopoverWidth ?? clampJsonStringPreviewPopoverWidth(savedPopoverWidth);
  const popoverMaxHeight = livePopoverMaxHeight ?? clampJsonStringPreviewPopoverMaxHeight(savedPopoverMaxHeight);
  const ownerWindow = getOwnerWindow(buttonRef.current, rootRef.current, editor?.getDomNode());
  const viewport = getWindowViewport(ownerWindow);
  const visiblePopoverWidth = getVisibleJsonStringPreviewPopoverWidth(popoverWidth, popover?.left, viewport.width);
  const visiblePopoverMaxHeight = getVisibleJsonStringPreviewPopoverMaxHeight(
    popoverMaxHeight,
    popover?.top,
    viewport.height,
  );
  const visibleEditModalSize = getVisibleJsonStringEditModalSize(savedEditModalSize, viewport);

  rangesRef.current = ranges;
  buttonStateRef.current = buttonState;
  popoverOpenRef.current = popover != null;
  popoverStateRef.current = popover;

  const getButtonStateForRange = useCallback(
    (range: JsonStringPreviewRange): ButtonState | undefined =>
      editor
        ? getJsonStringPreviewButtonPlacement({
            coordinateMode: buttonCoordinateMode,
            editor,
            range,
            rootElement: rootRef.current,
          })
        : undefined,
    [buttonCoordinateMode, editor, rootRef],
  );

  const setVisibleButtonState = useCallback((nextButtonState: ButtonState | null) => {
    dispatchInteraction({ button: nextButtonState, type: 'setButton' });
  }, []);

  const clearPreviewAffordance = useCallback((reason: JsonStringPreviewCloseReason = 'anchor-unavailable') => {
    popoverOpenRef.current = false;
    buttonKeepsPreviewRef.current = false;
    editModalResizeActiveRef.current = false;
    activeRangeRef.current = null;
    buttonRangeRef.current = null;
    dispatchInteraction({ reason, type: 'clear' });
  }, []);

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

  const getButtonViewportRect = useCallback(
    (button: ButtonState): JsonStringPreviewAnchorRect | undefined => {
      const rootElement = rootRef.current;
      const rootRect = buttonCoordinateMode === 'root' ? rootElement?.getBoundingClientRect() : undefined;

      if (buttonCoordinateMode === 'root' && !rootRect) {
        return undefined;
      }

      const left = (rootRect?.left ?? 0) + button.left;
      const top = (rootRect?.top ?? 0) + button.top;

      return {
        bottom: top + 20,
        left,
      };
    },
    [buttonCoordinateMode, rootRef],
  );

  const calculatePopoverPosition = useCallback(
    (buttonRect: JsonStringPreviewAnchorRect) =>
      calculateJsonStringPreviewPopoverPosition(buttonRect, popoverWidth, getWindowViewport(ownerWindow)),
    [ownerWindow, popoverWidth],
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
      dispatchInteraction({ ...nextPosition, type: 'patchPopover' });
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
    (restoreButtonFocus = false, reason: JsonStringPreviewCloseReason = 'outside-click') => {
      popoverOpenRef.current = false;
      dispatchInteraction({ reason, type: 'closePopover' });

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
    dispatchInteraction({ range, ...position, type: 'openPopover' });
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
    dispatchInteraction({ left: rightEdge - nextWidth, type: 'patchPopover' });
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
      dispatchInteraction({ range, type: 'openEdit' });
    },
    [],
  );

  const closeEditModal = useCallback(() => {
    clearPreviewAffordance('edit-cancel');
  }, [clearPreviewAffordance]);

  const saveEditModal = useCallback(() => {
    if (!editModal || !onEditString) {
      return;
    }

    onEditString(editModal.range, editModal.draft);
    clearPreviewAffordance('edit-save');
  }, [clearPreviewAffordance, editModal, onEditString]);

  const handleEditModalPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const modal = editModalRef.current;

    if (!modal) {
      return;
    }

    const rect = modal.getBoundingClientRect();
    const isResizeCorner =
      event.clientX >= rect.right - EDIT_MODAL_RESIZE_HITBOX && event.clientY >= rect.bottom - EDIT_MODAL_RESIZE_HITBOX;

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
      clearPreviewAffordance('unmount');
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

      showButtonForRange(getJsonStringPreviewRangeAtMouseEvent(editor, event, getRangeAtPosition));
    });
    const mouseDownDisposable = editor.onMouseDown((event) => {
      showButtonForRange(getJsonStringPreviewRangeAtMouseEvent(editor, event, getRangeAtPosition));
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
    getRangeAtPosition,
    hideButton,
    ranges.length,
    rootRef,
    setVisibleButtonState,
    showButtonForRange,
  ]);

  useEffect(() => {
    clearPreviewAffordance('text-change');
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
      closePopover(true, 'escape');
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
          { height: rect.height, width: rect.width },
          getWindowViewport(modalWindow),
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
    <JsonStringPreviewButton
      coordinateMode={buttonCoordinateMode}
      onClosePopover={() => closePopover(true, 'escape')}
      onHide={hideButton}
      onKeepPreviewChange={(keep) => {
        buttonKeepsPreviewRef.current = keep;
      }}
      onOpen={openPopover}
      placement={buttonState}
      popoverOpen={popoverOpenRef.current}
      refObject={buttonRef}
    />
  ) : null;
  const popoverElement = popover ? (
    <JsonStringPreviewPopover
      decodedTextRef={decodedTextRef}
      maxHeight={visiblePopoverMaxHeight}
      onEdit={onEditString ? () => openEditModal(popover.range) : undefined}
      onResizeKeyDown={handleResizeKeyDown}
      onResizePointerDown={handleResizePointerDown}
      position={popover}
      range={popover.range}
      refObject={popoverRef}
      width={visiblePopoverWidth}
    />
  ) : null;
  const editModalElement = editModal ? (
    <EditJsonStringModal
      draft={editModal.draft}
      onCancel={closeEditModal}
      onChange={(draft) => dispatchInteraction({ draft, type: 'updateEditDraft' })}
      onPointerDownCapture={handleEditModalPointerDownCapture}
      onSave={saveEditModal}
      refObject={editModalRef}
      size={visibleEditModalSize}
      textAreaRef={editTextAreaRef}
    />
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

function getOwnerWindow(...elements: Array<Element | null | undefined>): Window {
  return elements.find(Boolean)?.ownerDocument.defaultView ?? window;
}

function getWindowViewport(ownerWindow: Window): { height: number; width: number } {
  return { height: ownerWindow.innerHeight, width: ownerWindow.innerWidth };
}
