import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { fullscreenOutputEditorFontSizeState, multilineEditorFontSizeState } from '../state/ui.js';
import {
  adjustMultilineEditorFontSize,
  clampMultilineEditorFontSize,
  getMultilineEditorFontSizeCommand,
  getMultilineEditorFontSizeWheelCommand,
  type MultilineEditorFontSizeKeyEvent,
  type MultilineEditorFontSizeWheelEvent,
} from '../utils/multilineEditorFontSize.js';

type HandledMultilineEditorFontSizeKeyEvent = MultilineEditorFontSizeKeyEvent & {
  preventDefault(): void;
  stopPropagation(): void;
};

type HandledMultilineEditorFontSizeWheelEvent = MultilineEditorFontSizeWheelEvent & {
  preventDefault(): void;
  stopPropagation(): void;
};

export type MultilineEditorFontSizeScope = 'editor' | 'fullscreen-output';

function getFontSizeState(scope: MultilineEditorFontSizeScope) {
  return scope === 'fullscreen-output' ? fullscreenOutputEditorFontSizeState : multilineEditorFontSizeState;
}

export const useMultilineEditorFontSize = (scope: MultilineEditorFontSizeScope = 'editor') => {
  const [storedFontSize, setStoredFontSize] = useAtom(getFontSizeState(scope));
  const normalizedFontSize = clampMultilineEditorFontSize(storedFontSize);

  useEffect(() => {
    if (storedFontSize !== normalizedFontSize) {
      setStoredFontSize(normalizedFontSize);
    }
  }, [normalizedFontSize, setStoredFontSize, storedFontSize]);

  const setNormalizedFontSize = useCallback(
    (nextFontSize: number | ((currentFontSize: number) => number)) => {
      setStoredFontSize((currentFontSize) => {
        const normalizedCurrentFontSize = clampMultilineEditorFontSize(currentFontSize);
        const resolvedNextFontSize =
          typeof nextFontSize === 'function' ? nextFontSize(normalizedCurrentFontSize) : nextFontSize;

        return clampMultilineEditorFontSize(resolvedNextFontSize);
      });
    },
    [setStoredFontSize],
  );

  const adjustFontSize = useCallback(
    (command: 'increase' | 'decrease' | 'reset') => {
      setNormalizedFontSize((currentFontSize) => adjustMultilineEditorFontSize(currentFontSize, command));
    },
    [setNormalizedFontSize],
  );

  const handleKeyDown = useCallback(
    (event: HandledMultilineEditorFontSizeKeyEvent): boolean => {
      const command = getMultilineEditorFontSizeCommand(event);

      if (!command) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      adjustFontSize(command);
      return true;
    },
    [adjustFontSize],
  );

  const handleWheel = useCallback(
    (event: HandledMultilineEditorFontSizeWheelEvent): boolean => {
      const command = getMultilineEditorFontSizeWheelCommand(event);

      if (!command) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();

      adjustFontSize(command);
      return true;
    },
    [adjustFontSize],
  );

  return {
    fontSize: normalizedFontSize,
    adjustFontSize,
    handleKeyDown,
    handleWheel,
  };
};
