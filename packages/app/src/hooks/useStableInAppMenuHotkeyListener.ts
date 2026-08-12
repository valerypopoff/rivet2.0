import { useEffect } from 'react';
import {
  installInAppMenuHotkeyListener,
  type InAppMenuHotkeyCommandRunner,
  type InAppMenuHotkeyRuntimeConfig,
} from '../utils/inAppMenuHotkeys.js';
import { useUnrenderedValue } from './useUnrenderedValue.js';

interface InAppMenuHotkeyWindow extends Window {
  __rivetInAppMenuHotkeysCleanup?: () => void;
}

export function useStableInAppMenuHotkeyListener(options: {
  enabled: boolean;
  runMenuCommand: InAppMenuHotkeyCommandRunner;
  runtimeConfig: InAppMenuHotkeyRuntimeConfig;
}): void {
  const unrenderedRuntimeConfig = useUnrenderedValue(options.runtimeConfig);
  const unrenderedRunMenuCommand = useUnrenderedValue(options.runMenuCommand);

  useEffect(() => {
    if (typeof window === 'undefined' || !options.enabled) {
      return;
    }

    const hotkeyWindow = window as InAppMenuHotkeyWindow;
    hotkeyWindow.__rivetInAppMenuHotkeysCleanup?.();

    const cleanup = installInAppMenuHotkeyListener(
      hotkeyWindow,
      () => unrenderedRuntimeConfig.value,
      () => unrenderedRunMenuCommand.value,
    );

    hotkeyWindow.__rivetInAppMenuHotkeysCleanup = cleanup;

    return () => {
      if (hotkeyWindow.__rivetInAppMenuHotkeysCleanup === cleanup) {
        cleanup();
        delete hotkeyWindow.__rivetInAppMenuHotkeysCleanup;
      }
    };
  }, [options.enabled, unrenderedRunMenuCommand, unrenderedRuntimeConfig]);
}
