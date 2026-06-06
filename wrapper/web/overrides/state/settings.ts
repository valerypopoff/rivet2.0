// Override for rivet/packages/app/src/state/settings.ts
// Keeps upstream settings behavior while adjusting hosted-only defaults.

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { createHybridStorage } from '../../../../rivet/packages/app/src/state/storage.js';
import { isHostedMode } from '../utils/tauri';
import { RIVET_REMOTE_DEBUGGER_DEFAULT_WS } from '../../../shared/hosted-env';

export * from '../../../../rivet/packages/app/src/state/settings.js';

// Legacy storage key for recoil-persist to avoid breaking existing users' settings.
const { storage } = createHybridStorage('recoil-persist', undefined, { debounceMs: 0 });

export const updateModalOpenState = atom<boolean>(false);

export const debuggerDefaultUrlState = atomWithStorage(
  'debuggerDefaultUrl',
  isHostedMode() ? RIVET_REMOTE_DEBUGGER_DEFAULT_WS : 'ws://localhost:21888',
  storage,
);
