// Override for rivet/packages/app/src/state/settings.ts
// Shows Node executor in hosted mode, uses env-driven debugger URL

import { atom } from 'jotai';
import { atomWithDefault, atomWithStorage } from 'jotai/utils';
import { DEFAULT_CHAT_NODE_TIMEOUT, type Settings } from '@valerypopoff/rivet2-core';
import { isInTauri, isHostedMode } from '../utils/tauri';
import { createHybridStorage, memoryStorage } from '../../../../rivet/packages/app/src/state/storage.js';
import { RIVET_REMOTE_DEBUGGER_DEFAULT_WS } from '../../../shared/hosted-env';

// Legacy storage key for recoil-persist to avoid breaking existing users' settings
const { storage } = createHybridStorage('recoil-persist', undefined, { debounceMs: 0 });

export const settingsState = atomWithStorage<Settings>(
  'settings',
  {
    recordingPlaybackLatency: 1000,
    defaultNodeColors: false,
    openNodeSettingsOnCreate: true,

    openAiKey: '',
    openAiOrganization: '',
    openAiEndpoint: '',
    chatNodeTimeout: DEFAULT_CHAT_NODE_TIMEOUT,

    pluginEnv: {},
    pluginSettings: {},
  },
  storage,
);

export type EditorPreferences = {
  applyDefaultNodeColors: boolean;
  openNodeSettingsOnCreate: boolean;
};

export function resolveEditorPreferences(
  settings: Partial<Pick<Settings, 'defaultNodeColors' | 'openNodeSettingsOnCreate'>> | undefined,
): EditorPreferences {
  return {
    applyDefaultNodeColors: settings?.defaultNodeColors ?? false,
    openNodeSettingsOnCreate: settings?.openNodeSettingsOnCreate ?? true,
  };
}

export const themes = [
  {
    label: 'Molten',
    value: 'molten',
  },
  {
    label: 'Grapefruit',
    value: 'grapefruit',
  },
  {
    label: 'Taffy',
    value: 'taffy',
  },
] as const;

export type Theme = (typeof themes)[number]['value'];

export const themeState = atomWithStorage<Theme>('theme', 'molten', storage);

export const recordExecutionsState = atomWithStorage<boolean>('recordExecutions', true, storage);

export const showNodeRunDurationsState = atomWithStorage<boolean>('showNodeRunDurations', false, storage);

export type DefaultExecutor = 'browser' | 'nodejs';

export const defaultExecutorState = atomWithStorage<DefaultExecutor>('defaultExecutor', 'browser', storage);

export function getStartupDefaultExecutor(): DefaultExecutor {
  const value = memoryStorage.get('recoil-persist')?.defaultExecutor;
  return value === 'nodejs' || value === 'browser' ? value : 'browser';
}

export const selectedExecutorState = atomWithDefault<DefaultExecutor>(() => getStartupDefaultExecutor());

const browserExecutorOption = { label: 'Browser', value: 'browser' } as const;
const nodeExecutorOption = { label: 'Node', value: 'nodejs' } as const;
const browserExecutorOptions = [browserExecutorOption] as const;
const browserAndNodeExecutorOptions = [browserExecutorOption, nodeExecutorOption] as const;

export type ExecutorOption = typeof browserExecutorOption | typeof nodeExecutorOption;

export function getExecutorOptions({
  hasInternalExecutorUrl = false,
  isDesktop = isInTauri(),
}: {
  hasInternalExecutorUrl?: boolean;
  isDesktop?: boolean;
} = {}): readonly ExecutorOption[] {
  return isDesktop || hasInternalExecutorUrl ? browserAndNodeExecutorOptions : browserExecutorOptions;
}

export const previousDataPerNodeToKeepState = atomWithStorage<number>('previousDataPerNodeToKeep', -1, storage);

export const preservePortTextCaseState = atomWithStorage<boolean>('preservePortTextCase', false, storage);

export const checkForUpdatesState = atomWithStorage<boolean>('checkForUpdates', true, storage);

export const skippedMaxVersionState = atomWithStorage<string | undefined>('skippedMaxVersion', undefined, storage);

export const updateModalOpenState = atom<boolean>(false);

export const zoomSensitivityState = atomWithStorage<number>('zoomSensitivity', 0.25, storage);

export const canvasBackgroundPatterns = [
  {
    label: 'Grid',
    value: 'grid',
  },
  {
    label: 'Dots',
    value: 'dots',
  },
  {
    label: 'Crosses',
    value: 'crosses',
  },
] as const;

export type CanvasBackgroundPattern = (typeof canvasBackgroundPatterns)[number]['value'];

export function resolveCanvasBackgroundPattern(value: unknown): CanvasBackgroundPattern {
  return canvasBackgroundPatterns.some((pattern) => pattern.value === value) ? (value as CanvasBackgroundPattern) : 'grid';
}

export const DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY = 0.02;
export const MIN_CANVAS_BACKGROUND_PATTERN_OPACITY = 0;
export const MAX_CANVAS_BACKGROUND_PATTERN_OPACITY = 0.12;
export const CANVAS_BACKGROUND_PATTERN_OPACITY_STEP = 0.005;

export function clampCanvasBackgroundPatternOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY;
  }

  return Math.min(
    MAX_CANVAS_BACKGROUND_PATTERN_OPACITY,
    Math.max(MIN_CANVAS_BACKGROUND_PATTERN_OPACITY, value),
  );
}

export const canvasBackgroundPatternState = atomWithStorage<CanvasBackgroundPattern>(
  'canvasBackgroundPattern',
  'grid',
  storage,
);

export const canvasBackgroundPatternOpacityState = atomWithStorage<number>(
  'canvasBackgroundPatternOpacity',
  DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY,
  storage,
);

export const debuggerDefaultUrlState = atomWithStorage(
  'debuggerDefaultUrl',
  isHostedMode() ? RIVET_REMOTE_DEBUGGER_DEFAULT_WS : 'ws://localhost:21888',
  storage,
);
