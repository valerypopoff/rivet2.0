import { useAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { codeEditorHeightsByStorageKeyState } from '../../state/ui.js';

type ResizeHandleMouseEvent = globalThis.MouseEvent;

// Keep the shared defaults aligned between resizable and non-resizable editors.
export const DEFAULT_HEIGHT = 500;
export const MIN_HEIGHT = 200;
export const RESIZABLE_LANGUAGES = new Set(['javascript', 'json', 'jsonpath', 'prompt-interpolation-markdown']);

export function isValidHeight(height: number | undefined): height is number {
  return typeof height === 'number' && Number.isFinite(height) && height > 0;
}

export function resolveStaticViewportHeight(defaultHeight: number | undefined): number {
  return isValidHeight(defaultHeight) ? Math.max(MIN_HEIGHT, Math.round(defaultHeight)) : DEFAULT_HEIGHT;
}

export function buildCodeEditorHeightStorageKey({
  nodeType,
  editorKey,
}: {
  nodeType: string | undefined;
  editorKey: string | undefined;
}): string | undefined {
  if (nodeType == null) {
    return undefined;
  }

  const normalizedEditorKey = editorKey?.trim();

  return normalizedEditorKey ? `${nodeType}:${normalizedEditorKey}` : nodeType;
}

export function resolveViewportHeight({
  nodeType,
  editorKey,
  defaultHeight,
  persistedHeights,
}: {
  nodeType: string | undefined;
  editorKey: string | undefined;
  defaultHeight: number | undefined;
  persistedHeights: Record<string, number>;
}): number {
  const storageKey = buildCodeEditorHeightStorageKey({ nodeType, editorKey });
  const persistedHeight = storageKey ? persistedHeights[storageKey] : undefined;
  const legacyPersistedHeight = nodeType ? persistedHeights[nodeType] : undefined;
  const resolvedPersistedHeight = isValidHeight(persistedHeight)
    ? persistedHeight
    : isValidHeight(legacyPersistedHeight)
      ? legacyPersistedHeight
      : undefined;

  return isValidHeight(resolvedPersistedHeight)
    ? Math.max(MIN_HEIGHT, Math.round(resolvedPersistedHeight))
    : isValidHeight(defaultHeight)
      ? Math.max(MIN_HEIGHT, Math.round(defaultHeight))
      : DEFAULT_HEIGHT;
}

export function useNodeEditorCodeViewportHeight({
  nodeType,
  editorKey,
  defaultHeight,
}: {
  nodeType: string | undefined;
  editorKey: string | undefined;
  defaultHeight: number | undefined;
}) {
  const [persistedHeightsByStorageKey, setPersistedHeightsByStorageKey] = useAtom(codeEditorHeightsByStorageKeyState);
  const dragStartHeight = useRef<number | undefined>(undefined);
  const dragStartClientY = useRef(0);
  const currentViewportHeightRef = useRef<number>(DEFAULT_HEIGHT);
  const storageKey = buildCodeEditorHeightStorageKey({ nodeType, editorKey });
  const resolvedViewportHeight = resolveViewportHeight({
    nodeType,
    editorKey,
    defaultHeight,
    persistedHeights: persistedHeightsByStorageKey,
  });
  const [viewportHeight, setViewportHeight] = useState(resolvedViewportHeight);

  currentViewportHeightRef.current = viewportHeight;

  useEffect(() => {
    setViewportHeight(resolvedViewportHeight);
  }, [nodeType, editorKey, resolvedViewportHeight]);

  const onResizeStart = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();
    dragStartHeight.current = viewportHeight;
    dragStartClientY.current = event.clientY;
  };

  const onResizeMove = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();

    if (dragStartHeight.current == null) {
      return;
    }

    const nextViewportHeight = Math.max(
      MIN_HEIGHT,
      Math.round(dragStartHeight.current + (event.clientY - dragStartClientY.current)),
    );
    currentViewportHeightRef.current = nextViewportHeight;
    setViewportHeight(nextViewportHeight);
  };

  const onResizeEnd = (event: ResizeHandleMouseEvent) => {
    event.preventDefault();

    const dragStart = dragStartHeight.current;
    const finalViewportHeight =
      dragStart == null
        ? currentViewportHeightRef.current
        : Math.max(MIN_HEIGHT, Math.round(dragStart + (event.clientY - dragStartClientY.current)));

    currentViewportHeightRef.current = finalViewportHeight;
    setViewportHeight(finalViewportHeight);
    dragStartHeight.current = undefined;

    if (storageKey == null) {
      return;
    }

    setPersistedHeightsByStorageKey((previous) =>
      previous[storageKey] === finalViewportHeight
        ? previous
        : {
            ...previous,
            [storageKey]: finalViewportHeight,
          },
    );
  };

  return {
    viewportHeight,
    resizeHandleProps: {
      onResizeStart,
      onResizeMove,
      onResizeEnd,
    },
  };
}
