export const DEFAULT_DEBUGGER_URL = 'ws://localhost:21888';

/** Hosts supply endpoint policy, not a replacement settings atom or connection implementation. */
export type DebuggerConnectionPolicy = {
  getDefaultUrl: () => string;
  normalizeUrl?: (url: string) => string;
};

export function resolveDebuggerPreference(value: unknown, policy?: DebuggerConnectionPolicy): string {
  const url = typeof value === 'string' ? value : policy?.getDefaultUrl() ?? DEFAULT_DEBUGGER_URL;
  return policy?.normalizeUrl?.(url) ?? url;
}

export function resolveDebuggerConnectionUrl(value: string, policy?: DebuggerConnectionPolicy): string {
  return resolveDebuggerPreference(value === '' ? undefined : value, policy);
}
