import CopyIcon from 'majesticons/line/clipboard-line.svg?react';
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
import { monaco } from '../../utils/monaco.js';
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

type JsonStringPreviewAffordanceProps = {
  editor?: monaco.editor.IStandaloneCodeEditor;
  enabled: boolean;
  rootRef: MutableRefObject<HTMLDivElement | null>;
  text: string;
  widgetId: string;
};

type PopoverState = {
  left: number;
  range: JsonStringPreviewRange;
  top: number;
};

export const JsonStringPreviewAffordance: FC<JsonStringPreviewAffordanceProps> = ({
  editor,
  enabled,
  rootRef,
  text,
  widgetId,
}) => {
  const [savedPopoverWidth, setSavedPopoverWidth] = useAtom(jsonStringPreviewPopoverWidthState);
  const ranges = useMemo(() => (enabled ? getJsonStringPreviewRanges(text) : []), [enabled, text]);
  const rangesRef = useRef(ranges);
  const activeRangeRef = useRef<JsonStringPreviewRange | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const widgetRef = useRef<monaco.editor.IContentWidget | null>(null);
  const buttonKeepsPreviewRef = useRef(false);
  const popoverOpenRef = useRef(false);
  const [livePopoverWidth, setLivePopoverWidth] = useState<number | null>(null);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const popoverRangeId = popover?.range.id;
  const popoverWidth = livePopoverWidth ?? clampJsonStringPreviewPopoverWidth(savedPopoverWidth);
  const visiblePopoverWidth = getVisibleJsonStringPreviewPopoverWidth(
    popoverWidth,
    popover?.left,
    buttonRef.current?.ownerDocument.defaultView,
  );

  rangesRef.current = ranges;
  popoverOpenRef.current = popover != null;

  const layoutWidget = useCallback(() => {
    if (editor && widgetRef.current) {
      editor.layoutContentWidget(widgetRef.current);
    }
  }, [editor]);

  const hideButton = useCallback(() => {
    if (popoverOpenRef.current || buttonKeepsPreviewRef.current) {
      return;
    }

    activeRangeRef.current = null;
    layoutWidget();
  }, [layoutWidget]);

  const showButtonForRange = useCallback(
    (range: JsonStringPreviewRange | undefined) => {
      if (!range) {
        hideButton();
        return;
      }

      if (activeRangeRef.current?.id === range.id) {
        return;
      }

      activeRangeRef.current = range;
      layoutWidget();
    },
    [hideButton, layoutWidget],
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
        layoutWidget();
        requestAnimationFrame(() => buttonRef.current?.focus());
        return;
      }

      hideButton();
    },
    [hideButton, layoutWidget],
  );

  const openPopover = useCallback(() => {
    const range = activeRangeRef.current;
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
      setPopover(null);
      layoutWidget();
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'json-string-preview-button';
    button.textContent = 'Aa';
    button.title = 'Preview unescaped string';
    button.setAttribute('aria-label', 'Preview unescaped string');

    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPopover();
    });
    button.addEventListener('mouseenter', () => {
      buttonKeepsPreviewRef.current = true;
    });
    button.addEventListener('mouseleave', () => {
      buttonKeepsPreviewRef.current = false;
      hideButton();
    });
    button.addEventListener('focus', () => {
      buttonKeepsPreviewRef.current = true;
    });
    button.addEventListener('blur', () => {
      buttonKeepsPreviewRef.current = false;
      hideButton();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && popoverOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closePopover(true);
      }
    });

    const widget: monaco.editor.IContentWidget = {
      getDomNode: () => button,
      getId: () => widgetId,
      getPosition: () => {
        const model = editor.getModel();
        const activeRange = activeRangeRef.current;

        if (!model || !activeRange) {
          return null;
        }

        return {
          position: model.getPositionAt(activeRange.endOffset),
          preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
        };
      },
    };

    const handleRootMouseLeave = () => {
      const cursorRange = editor.hasTextFocus() ? getCursorRange() : undefined;

      if (cursorRange) {
        showButtonForRange(cursorRange);
        return;
      }

      hideButton();
    };

    buttonRef.current = button;
    widgetRef.current = widget;
    editor.addContentWidget(widget);

    const mouseMoveDisposable = editor.onMouseMove((event) => {
      showButtonForRange(getRangeAtPosition(event.target.position));
    });
    const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
      showButtonForRange(getRangeAtPosition(event.position));
    });
    const scrollDisposable = editor.onDidScrollChange(() => {
      layoutWidget();
    });
    const rootElement = rootRef.current;
    rootElement?.addEventListener('mouseleave', handleRootMouseLeave);
    showButtonForRange(getCursorRange());

    return () => {
      rootElement?.removeEventListener('mouseleave', handleRootMouseLeave);
      mouseMoveDisposable.dispose();
      cursorDisposable.dispose();
      scrollDisposable.dispose();
      editor.removeContentWidget(widget);
      buttonRef.current = null;
      widgetRef.current = null;
      activeRangeRef.current = null;
      buttonKeepsPreviewRef.current = false;
    };
  }, [
    closePopover,
    editor,
    enabled,
    getCursorRange,
    getRangeAtPosition,
    hideButton,
    layoutWidget,
    openPopover,
    ranges.length,
    rootRef,
    showButtonForRange,
    widgetId,
  ]);

  useEffect(() => {
    activeRangeRef.current = null;
    setPopover(null);
    layoutWidget();
  }, [layoutWidget, text]);

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

  if (!popover) {
    return null;
  }

  return (
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
