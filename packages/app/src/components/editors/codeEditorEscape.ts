import { type monaco } from '../../utils/monaco.js';

const SUGGEST_CONTROLLER_ID = 'editor.contrib.suggestController';
const FIND_CONTROLLER_ID = 'editor.contrib.findController';
const HIDDEN_SUGGEST_WIDGET_STATE = 0;

type MonacoSuggestWidgetLike = {
  _state?: number;
};

type MonacoSuggestControllerLike = {
  cancelSuggestWidget?: () => void;
  widget?: {
    isInitialized?: boolean;
    value?: MonacoSuggestWidgetLike;
  };
};

type MonacoFindControllerLike = {
  closeFindWidget?: () => void;
  getState?: () => {
    isRevealed?: boolean;
  };
};

export type CodeEditorEscapeResult = 'dismissed-suggest' | 'closed-find' | 'closed-panel' | 'noop';

export function getSuggestController(
  editor: monaco.editor.IStandaloneCodeEditor | undefined,
): MonacoSuggestControllerLike | undefined {
  return editor?.getContribution(SUGGEST_CONTROLLER_ID) as MonacoSuggestControllerLike | undefined;
}

function getFindController(
  editor: monaco.editor.IStandaloneCodeEditor | undefined,
): MonacoFindControllerLike | undefined {
  return editor?.getContribution(FIND_CONTROLLER_ID) as MonacoFindControllerLike | undefined;
}

export function hasActiveSuggestWidget(controller: MonacoSuggestControllerLike | undefined): boolean {
  if (controller?.widget?.isInitialized !== true) {
    return false;
  }

  // Monaco 0.44 uses `_state === 0` for a hidden suggest widget and non-zero
  // values for visible/loading/detail modes. Keep this internal coupling here.
  return (
    typeof controller.widget.value?._state === 'number' &&
    controller.widget.value._state !== HIDDEN_SUGGEST_WIDGET_STATE
  );
}

function hasActiveFindWidget(controller: MonacoFindControllerLike | undefined): boolean {
  return controller?.getState?.().isRevealed === true;
}

export function handleCodeEditorEscape({
  editor,
  onClose,
}: {
  editor: monaco.editor.IStandaloneCodeEditor | undefined;
  onClose?: () => void;
}): CodeEditorEscapeResult {
  const suggestController = getSuggestController(editor);

  if (hasActiveSuggestWidget(suggestController)) {
    suggestController?.cancelSuggestWidget?.();
    return 'dismissed-suggest';
  }

  const findController = getFindController(editor);

  if (hasActiveFindWidget(findController)) {
    findController?.closeFindWidget?.();
    return 'closed-find';
  }

  if (onClose) {
    onClose();
    return 'closed-panel';
  }

  return 'noop';
}
