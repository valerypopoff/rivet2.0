import { useEffect } from 'react';
import { useRunMenuCommand } from './useMenuCommands';
import { isMacOSPlatform, isWindowsPlatform } from '../utils/platform/os.js';
import { isInTauri } from '../utils/tauri.js';
import { getInAppMenuHotkeyCommand, type InAppMenuHotkeyPlatform } from '../utils/inAppMenuHotkeys.js';

interface InAppMenuHotkeyWindow extends Window {
  __rivetInAppMenuHotkeysCleanup?: () => void;
}
declare let window: InAppMenuHotkeyWindow;

const shouldUseInAppMenuHotkeys = isWindowsPlatform() || (isInTauri() && isMacOSPlatform());
const hotkeyListenerOptions = { capture: true };
const consumeRunHotkeySelector = '[data-rivet-consume-run-hotkey="true"]';

function getInAppMenuHotkeyPlatform(): InAppMenuHotkeyPlatform {
  return isMacOSPlatform() ? 'macos' : 'windows';
}

function shouldSkipInAppMenuHotkey(event: KeyboardEvent, command: string) {
  if (command !== 'run' || !(event.target instanceof Element)) {
    return false;
  }

  return event.target.closest(consumeRunHotkeySelector) != null;
}

export const useInAppMenuHotkeys = () => {
  const runMenuCommandImpl = useRunMenuCommand();

  useEffect(() => {
    if (typeof window === 'undefined' || !shouldUseInAppMenuHotkeys) {
      return;
    }

    window.__rivetInAppMenuHotkeysCleanup?.();
    const platform = getInAppMenuHotkeyPlatform();

    const onKeyDown = (event: KeyboardEvent) => {
      const command = getInAppMenuHotkeyCommand(event, platform);

      if (command) {
        if (shouldSkipInAppMenuHotkey(event, command)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (event.repeat) {
          return;
        }

        runMenuCommandImpl(command);
      }
    };

    window.addEventListener('keydown', onKeyDown, hotkeyListenerOptions);

    const cleanup = () => {
      window.removeEventListener('keydown', onKeyDown, hotkeyListenerOptions);
    };

    window.__rivetInAppMenuHotkeysCleanup = cleanup;

    return () => {
      if (window.__rivetInAppMenuHotkeysCleanup === cleanup) {
        cleanup();
        delete window.__rivetInAppMenuHotkeysCleanup;
      }
    };
  }, [runMenuCommandImpl]);

  return shouldUseInAppMenuHotkeys;
};
