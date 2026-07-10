import type { monaco } from '../../../utils/monaco.js';
import type { JsonStringPreviewRange } from '../jsonStringPreviewRanges.js';

const BUTTON_VIEWPORT_WIDTH = 30;
const BUTTON_VIEWPORT_HEIGHT = 20;
const BUTTON_ANCHOR_OFFSET_X = 4;
const BUTTON_ANCHOR_OFFSET_Y = 1;

export type JsonStringPreviewButtonCoordinateMode = 'root' | 'viewport';
export type JsonStringPreviewButtonPlacement = {
  left: number;
  range: JsonStringPreviewRange;
  top: number;
};

export function getJsonStringPreviewButtonPlacement(options: {
  coordinateMode: JsonStringPreviewButtonCoordinateMode;
  editor: monaco.editor.IStandaloneCodeEditor;
  range: JsonStringPreviewRange;
  rootElement?: HTMLElement | null;
}): JsonStringPreviewButtonPlacement | undefined {
  const { coordinateMode, editor, range, rootElement } = options;
  const model = editor.getModel();
  const editorElement = editor.getDomNode();

  if (!model || !editorElement || (coordinateMode === 'root' && !rootElement)) {
    return undefined;
  }

  const visiblePosition = editor.getScrolledVisiblePosition(model.getPositionAt(range.endOffset));
  if (!visiblePosition || !doesScrolledPositionFitPreviewButton(visiblePosition, editor.getLayoutInfo())) {
    return undefined;
  }

  const editorRect = editorElement.getBoundingClientRect();
  const rootRect = coordinateMode === 'root' ? rootElement?.getBoundingClientRect() : undefined;

  return {
    left: editorRect.left + visiblePosition.left - (rootRect?.left ?? 0) + BUTTON_ANCHOR_OFFSET_X,
    range,
    top: editorRect.top + visiblePosition.top - (rootRect?.top ?? 0) + BUTTON_ANCHOR_OFFSET_Y,
  };
}

export function getJsonStringPreviewRangeAtMouseEvent(
  editor: monaco.editor.IStandaloneCodeEditor,
  event: monaco.editor.IEditorMouseEvent,
  findRange: (position: monaco.IPosition | null | undefined) => JsonStringPreviewRange | undefined,
): JsonStringPreviewRange | undefined {
  if (event.target.position) {
    return findRange(event.target.position);
  }

  const { clientX, clientY } = event.event.browserEvent;
  return findRange(editor.getTargetAtClientPoint(clientX, clientY)?.position);
}

function doesScrolledPositionFitPreviewButton(
  visiblePosition: { left: number; top: number; height: number },
  layout: monaco.editor.EditorLayoutInfo,
): boolean {
  return (
    visiblePosition.top >= 0 &&
    visiblePosition.top + Math.max(1, visiblePosition.height) > 0 &&
    visiblePosition.top + BUTTON_VIEWPORT_HEIGHT <= layout.height &&
    visiblePosition.left >= 0 &&
    visiblePosition.left + BUTTON_VIEWPORT_WIDTH <= layout.width
  );
}
