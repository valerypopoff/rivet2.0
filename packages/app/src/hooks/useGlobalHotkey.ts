import { useLatest } from 'ahooks';
import { useEffect } from 'react';

interface UseGlobalHotkeyOptions {
  notWhenInputFocused?: boolean;
}

function isTextEntryFocused(): boolean {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName) || activeElement.isContentEditable;
}

export const useGlobalHotkey = (
  key: string,
  action: (event: KeyboardEvent) => void,
  options: UseGlobalHotkeyOptions = { notWhenInputFocused: false },
) => {
  const latestAction = useLatest(action);
  const notWhenInputFocused = options.notWhenInputFocused ?? false;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === key && (!notWhenInputFocused || !isTextEntryFocused())) {
        latestAction.current?.(e);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [key, latestAction, notWhenInputFocused]);
};
