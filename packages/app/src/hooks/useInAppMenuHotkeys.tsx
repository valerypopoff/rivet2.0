import { useRunMenuCommand } from './useMenuCommands';
import { isMacOSPlatform, isWindowsPlatform } from '../utils/platform/os.js';
import { isInTauri } from '../utils/tauri.js';
import {
  shouldRegisterInAppMenuHotkeys,
  type InAppMenuHotkeyPlatform,
  type InAppMenuHotkeyPolicy,
} from '../utils/inAppMenuHotkeys.js';
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { useStableInAppMenuHotkeyListener } from './useStableInAppMenuHotkeyListener.js';

function getInAppMenuHotkeyPlatform(): InAppMenuHotkeyPlatform {
  if (isMacOSPlatform()) {
    return 'macos';
  }

  return isWindowsPlatform() ? 'windows' : 'linux';
}

function getInAppMenuHotkeyPolicy(saveProject: boolean | undefined): InAppMenuHotkeyPolicy {
  return {
    legacyShortcutsEnabled: isWindowsPlatform() || (isInTauri() && isMacOSPlatform()),
    saveProject,
  };
}

export const useInAppMenuHotkeys = () => {
  const runMenuCommandImpl = useRunMenuCommand();
  const hostUiConfig = useRivetAppHostUiConfig();
  const runtimeConfig = {
    platform: getInAppMenuHotkeyPlatform(),
    policy: getInAppMenuHotkeyPolicy(hostUiConfig.keyboardShortcuts?.saveProject),
  };
  const listenerEnabled = shouldRegisterInAppMenuHotkeys(runtimeConfig.policy);

  useStableInAppMenuHotkeyListener({
    enabled: listenerEnabled,
    runMenuCommand: runMenuCommandImpl,
    runtimeConfig,
  });

  return listenerEnabled;
};
