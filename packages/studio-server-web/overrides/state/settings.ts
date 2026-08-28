// Override for packages/app/src/state/settings.ts
// Keeps upstream settings behavior while adjusting hosted-only defaults.

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage';
import { createHybridStorage } from '../../../app/src/state/storage.js';
import { isHostedMode } from '../utils/tauri';
import {
  normalizeRuntimeWebSocketUrl,
  RIVET_REMOTE_DEBUGGER_DEFAULT_WS,
} from '../../../studio-server-shared/hosted-env';

export * from '../../../app/src/state/settings.js';

// Legacy storage key for recoil-persist to avoid breaking existing users' settings.
const { storage } = createHybridStorage('recoil-persist', undefined, { debounceMs: 0 });

export const updateModalOpenState = atom<boolean>(false);

function normalizeDebuggerDefaultUrl(value: unknown, fallback: string): string {
  return normalizeRuntimeWebSocketUrl(typeof value === 'string' ? value : fallback);
}

const debuggerDefaultUrlStorage: SyncStorage<string> = {
  getItem: (key, initialValue) => normalizeDebuggerDefaultUrl(storage.getItem(key, initialValue), initialValue),
  setItem: (key, value) => storage.setItem(key, normalizeDebuggerDefaultUrl(value, RIVET_REMOTE_DEBUGGER_DEFAULT_WS)),
  removeItem: (key) => storage.removeItem(key),
};

export const debuggerDefaultUrlState = atomWithStorage(
  'debuggerDefaultUrl',
  isHostedMode() ? RIVET_REMOTE_DEBUGGER_DEFAULT_WS : 'ws://localhost:21888',
  isHostedMode() ? debuggerDefaultUrlStorage : storage,
);
