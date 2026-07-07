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

function getInAppMenuHotkeyPlatform(): InAppMenuHotkeyPlatform {
  return isMacOSPlatform() ? 'macos' : 'windows';
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
