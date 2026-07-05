import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
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
  DEFAULT_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH,
  jsonStringPreviewPopoverWidthState,
} from '../../state/ui.js';
import {
  findJsonStringPreviewRangeAtOffset,
  getJsonStringPreviewRanges,
  type JsonStringPreviewRange,
} from './jsonStringPreviewRanges.js';

const POPOVER_MAX_HEIGHT = 280;
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 12;
const POPOVER_WIDTH_KEYBOARD_STEP = 20;

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
    transform: translate(4px, 1px);
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
    padding: 8px 10px;
  }

  .json-string-preview-popover-header > span {
    color: var(--grey-light);
    flex: 1;
    font-size: var(--ui-font-size-sm);
    font-weight: 700;
    min-width: 0;
  }

  .json-string-preview-copy-button {
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

  .json-string-preview-copy-button:hover,
  .json-string-preview-copy-button:focus-visible {
    color: var(--primary);
    outline: none;
  }

  .json-string-preview-copy-button svg {
    height: 14px;
    width: 14px;
  }

  .json-string-preview-popover pre {
    color: var(--grey-lightest);
    font-family: var(--font-family-monospace);
    font-size: var(--ui-font-size-sm);
    line-height: 1.45;
    margin: 0;
    max-height: ${POPOVER_MAX_HEIGHT}px;
    overflow: auto;
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-string-preview-resize-handle {
    background: transparent;
    border: 0;
    bottom: 0;
    cursor: ew-resize;
    padding: 0;
    position: absolute;
    right: -4px;
    top: 0;
    width: 10px;
  }

  .json-string-preview-resize-handle::after {
    background: color-mix(in srgb, var(--primary) 70%, transparent);
    border-radius: 999px;
    bottom: 12px;
    content: '';
    opacity: 0;
    position: absolute;
    right: 4px;
    top: 12px;
    transition: opacity 120ms ease-out;
    width: 2px;
  }

  .json-string-preview-resize-handle:hover::after,
  .json-string-preview-resize-handle:focus-visible::after {
    opacity: 1;
  }

  .json-string-preview-resize-handle:focus-visible {
    outline: none;
  }
`;

type JsonStringPreviewAffordanceProps = {
  buttonCoordinateMode?: 'root' | 'viewport';
  editor?: monaco.editor.IStandaloneCodeEditor;
  enabled: boolean;
  minDecodedLength?: number;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  text: string;
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

export const JsonStringPreviewAffordance: FC<JsonStringPreviewAffordanceProps> = ({
  buttonCoordinateMode = 'viewport',
  editor,
  enabled,
  minDecodedLength,
  rootRef,
  text,
}) => {
  const [savedPopoverWidth, setSavedPopoverWidth] = useAtom(jsonStringPreviewPopoverWidthState);
  const ranges = useMemo(
    () => (enabled ? getJsonStringPreviewRanges(text, { minDecodedLength }) : []),
    [enabled, minDecodedLength, text],
  );
  const rangesRef = useRef(ranges);
  const activeRangeRef = useRef<JsonStringPreviewRange | null>(null);
  const buttonRangeRef = useRef<JsonStringPreviewRange | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const buttonStateRef = useRef<ButtonState | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const buttonKeepsPreviewRef = useRef(false);
  const popoverOpenRef = useRef(false);
  const [livePopoverWidth, setLivePopoverWidth] = useState<number | null>(null);
  const [buttonState, setButtonState] = useState<ButtonState | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverRangeId = popover?.range.id;
  const popoverWidth = livePopoverWidth ?? clampJsonStringPreviewPopoverWidth(savedPopoverWidth);
  const visiblePopoverWidth = getVisibleJsonStringPreviewPopoverWidth(
    popoverWidth,
    popover?.left,
    buttonRef.current?.ownerDocument.defaultView,
  );

  rangesRef.current = ranges;
  buttonStateRef.current = buttonState;
  popoverOpenRef.current = popover != null;

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

      const editorRect = editorElement.getBoundingClientRect();
      const coordinateMode = buttonCoordinateMode;

      if (coordinateMode === 'root' && !rootElement) {
        return undefined;
      }

      const rootRect = coordinateMode === 'root' ? rootElement?.getBoundingClientRect() : undefined;

      return {
        left: editorRect.left + visiblePosition.left - (rootRect?.left ?? 0),
        range,
        top: editorRect.top + visiblePosition.top - (rootRect?.top ?? 0),
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

  const hideButton = useCallback(() => {
    if (popoverOpenRef.current || buttonKeepsPreviewRef.current) {
      return;
    }

    activeRangeRef.current = null;
    buttonRangeRef.current = null;
    setVisibleButtonState(null);
  }, [setVisibleButtonState]);

  const showButtonForRange = useCallback(
    (range: JsonStringPreviewRange | undefined) => {
      if (!range) {
        hideButton();
        return;
      }

      const nextButtonState = getButtonStateForRange(range);

      if (!nextButtonState) {
        hideButton();
        return;
      }

      activeRangeRef.current = range;
      buttonRangeRef.current = range;
      setVisibleButtonState(nextButtonState);
    },
    [getButtonStateForRange, hideButton, setVisibleButtonState],
  );

  const getRangeAtPosition = useCallback(
    (position: monaco.IPosition | null | undefined) => {
      const model = editor?.getModel();

      if (!model || !position) {
        return undefined;
      }

      return findJsonStringPreviewRangeAtOffset(rangesRef.current, model.getOffsetAt(position));
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

  const calculatePopoverPosition = useCallback(() => {
    const buttonRect = buttonRef.current?.getBoundingClientRect();

    if (!buttonRect) {
      return undefined;
    }

    const ownerWindow = buttonRef.current?.ownerDocument.defaultView ?? window;
    const viewportWidth = ownerWindow.innerWidth;
    const effectiveWidth = Math.min(popoverWidth, Math.max(MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH, viewportWidth - 24));
    const maxLeft = Math.max(VIEWPORT_PADDING, viewportWidth - effectiveWidth - VIEWPORT_PADDING);
    const left = Math.min(Math.max(buttonRect.left, VIEWPORT_PADDING), maxLeft);
    const belowTop = buttonRect.bottom + POPOVER_GAP;
    const aboveTop = buttonRect.top - POPOVER_MAX_HEIGHT - POPOVER_GAP;
    const top =
      belowTop + POPOVER_MAX_HEIGHT > ownerWindow.innerHeight - VIEWPORT_PADDING && aboveTop > VIEWPORT_PADDING
        ? aboveTop
        : belowTop;

    return {
      left,
      top: Math.max(VIEWPORT_PADDING, top),
    };
  }, [popoverWidth]);

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
    const range = buttonStateRef.current?.range ?? activeRangeRef.current ?? buttonRangeRef.current;
    const position = calculatePopoverPosition();

    if (!range || !position) {
      return;
    }

    popoverOpenRef.current = true;
    setPopover({ range, ...position });
  }, [calculatePopoverPosition]);

  const setPopoverWidth = useCallback(
    (width: number) => {
      const nextWidth = clampJsonStringPreviewPopoverWidth(width);
      setLivePopoverWidth(null);
      setSavedPopoverWidth(nextWidth);
    },
    [setSavedPopoverWidth],
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
      const startWidth = popoverWidth;

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        pointerEvent.preventDefault();
        setLivePopoverWidth(clampJsonStringPreviewPopoverWidth(startWidth + pointerEvent.clientX - startX));
      };

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        const finalWidth = clampJsonStringPreviewPopoverWidth(startWidth + pointerEvent.clientX - startX);
        setLivePopoverWidth(null);
        setSavedPopoverWidth(finalWidth);
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
    [cleanupResizeListeners, popoverWidth, setSavedPopoverWidth],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      let nextWidth: number;

      switch (event.key) {
        case 'ArrowLeft':
          nextWidth = popoverWidth - POPOVER_WIDTH_KEYBOARD_STEP;
          break;
        case 'ArrowRight':
          nextWidth = popoverWidth + POPOVER_WIDTH_KEYBOARD_STEP;
          break;
        case 'Home':
          nextWidth = MIN_JSON_STRING_PREVIEW_POPOVER_WIDTH;
          break;
        case 'End':
          nextWidth = MAX_JSON_STRING_PREVIEW_POPOVER_WIDTH;
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
      setPopoverWidth(nextWidth);
    },
    [popoverWidth, setPopoverWidth],
  );

  useLayoutEffect(() => {
    if (!enabled || !editor || ranges.length === 0) {
      activeRangeRef.current = null;
      buttonRangeRef.current = null;
      setVisibleButtonState(null);
      setPopover(null);
      return;
    }

    const handleRootMouseLeave = () => {
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
        showButtonForRange(activeRange);
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
      activeRangeRef.current = null;
      buttonRangeRef.current = null;
      buttonKeepsPreviewRef.current = false;
      setVisibleButtonState(null);
    };
  }, [
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
    activeRangeRef.current = null;
    buttonRangeRef.current = null;
    setVisibleButtonState(null);
    setPopover(null);
  }, [setVisibleButtonState, text]);

  useEffect(() => cleanupResizeListeners, [cleanupResizeListeners]);

  useEffect(() => {
    if (!popoverRangeId) {
      return;
    }

    const popoverWindow = buttonRef.current?.ownerDocument.defaultView ?? window;
    const repositionPopover = () => {
      const nextPosition = calculatePopoverPosition();

      if (!nextPosition) {
        closePopover();
        return;
      }

      setPopover((currentPopover) => (currentPopover ? { ...currentPopover, ...nextPosition } : currentPopover));
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
  }, [calculatePopoverPosition, closePopover, editor, popoverRangeId]);

  if (!buttonState && !popover) {
    return null;
  }

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
        <button
          type="button"
          className="json-string-preview-copy-button"
          onClick={() => void copyToClipboard(popover.range.decodedValue)}
        >
          <CopyIcon />
          Copy value
        </button>
      </div>
      <pre>{popover.range.decodedValue}</pre>
      <button
        type="button"
        className="json-string-preview-resize-handle"
        aria-label="Resize preview width"
        title="Resize preview width"
        onPointerDown={handleResizePointerDown}
        onKeyDown={handleResizeKeyDown}
      />
    </div>
  ) : null;
  const popoverPortalElement = buttonRef.current?.ownerDocument.body;

  return (
    <>
      <Global styles={jsonStringPreviewAffordanceStyles} />
      {buttonState && (
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
      )}
      {popoverElement && popoverPortalElement ? createPortal(popoverElement, popoverPortalElement) : null}
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
