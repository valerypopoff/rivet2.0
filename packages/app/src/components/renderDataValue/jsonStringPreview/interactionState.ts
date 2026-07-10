import type { JsonStringPreviewRange } from '../jsonStringPreviewRanges.js';
import type { JsonStringPreviewButtonPlacement } from './monacoAdapter.js';

export type JsonStringPreviewCloseReason =
  | 'anchor-unavailable'
  | 'edit-cancel'
  | 'edit-save'
  | 'escape'
  | 'outside-click'
  | 'text-change'
  | 'unmount';

export type JsonStringPreviewInteractionState = {
  button: JsonStringPreviewButtonPlacement | null;
  editModal: { draft: string; range: JsonStringPreviewRange } | null;
  popover: ({ left: number; top: number } & { range: JsonStringPreviewRange }) | null;
};

export type JsonStringPreviewInteractionAction =
  | { type: 'clear'; reason: JsonStringPreviewCloseReason }
  | { type: 'closePopover'; reason: JsonStringPreviewCloseReason }
  | { type: 'openEdit'; range: JsonStringPreviewRange }
  | { type: 'openPopover'; left: number; range: JsonStringPreviewRange; top: number }
  | { type: 'patchPopover'; left?: number; top?: number }
  | { type: 'setButton'; button: JsonStringPreviewButtonPlacement | null }
  | { type: 'updateEditDraft'; draft: string };

export const EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE: JsonStringPreviewInteractionState = {
  button: null,
  editModal: null,
  popover: null,
};

export function reduceJsonStringPreviewInteraction(
  state: JsonStringPreviewInteractionState,
  action: JsonStringPreviewInteractionAction,
): JsonStringPreviewInteractionState {
  switch (action.type) {
    case 'clear':
      return EMPTY_JSON_STRING_PREVIEW_INTERACTION_STATE;
    case 'closePopover':
      return state.popover ? { ...state, popover: null } : state;
    case 'openEdit':
      return {
        button: null,
        editModal: { draft: action.range.decodedValue, range: action.range },
        popover: null,
      };
    case 'openPopover':
      return { ...state, popover: { left: action.left, range: action.range, top: action.top } };
    case 'patchPopover':
      return state.popover ? { ...state, popover: { ...state.popover, ...action } } : state;
    case 'setButton':
      if (
        state.button?.range.id === action.button?.range.id &&
        state.button?.left === action.button?.left &&
        state.button?.top === action.button?.top
      ) {
        return state;
      }
      return { ...state, button: action.button };
    case 'updateEditDraft':
      return state.editModal ? { ...state, editModal: { ...state.editModal, draft: action.draft } } : state;
  }
}
