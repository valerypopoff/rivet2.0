import { useAtom } from 'jotai';
import { debuggerDefaultUrlState } from '../state/settings.js';
import { useRivetAppHostUiConfig } from '../providers/HostUiConfigContext.js';
import { resolveDebuggerConnectionUrl, resolveDebuggerPreference } from '../utils/debuggerConnectionSettings.js';

export function useDebuggerConnectionSettings() {
  const [storedUrl, setStoredUrl] = useAtom(debuggerDefaultUrlState);
  const { debuggerConnection: policy } = useRivetAppHostUiConfig();
  return {
    defaultUrl: resolveDebuggerPreference(storedUrl, policy),
    setDefaultUrl: (url: string) => setStoredUrl(resolveDebuggerPreference(url, policy)),
    resolveConnectionUrl: (url: string) => resolveDebuggerConnectionUrl(url, policy),
  };
}
