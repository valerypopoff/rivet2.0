import { atomWithDefault, atomWithStorage } from 'jotai/utils';
import { DEFAULT_CHAT_NODE_TIMEOUT, type Settings } from '@valerypopoff/rivet2-core';
import { isInTauri } from '../utils/tauri';
import { getContrastingMonochromeColor } from '../utils/colorContrast.js';
import { createHybridStorage, memoryStorage } from './storage.js';

export { graphBuilderImplementationModeState } from './graphBuilderAi.js';

// Legacy storage key for recoil-persist to avoid breaking existing users' settings
const { storage } = createHybridStorage('recoil-persist', undefined, { debounceMs: 0 });

export const settingsState = atomWithStorage<Settings>(
  'settings',
  {
    recordingPlaybackLatency: 1000,
    defaultNodeColors: false,
    openNodeSettingsOnCreate: true,

    openAiApiKey: '',
    openAiKey: '',
    anthropicApiKey: '',
    googleApiKey: '',
    customAiApiKey: '',
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
  {
    label: 'Bright',
    value: 'bright',
  },
  {
    label: 'Custom',
    value: 'custom',
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

export const canvasBackgroundColorOptions = [
  {
    label: 'Theme',
    value: 'theme',
  },
  {
    label: 'Custom',
    value: 'custom',
  },
] as const;

export type CanvasBackgroundColorMode = (typeof canvasBackgroundColorOptions)[number]['value'];

export type RgbaColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

const THEME_PRIMARY_COLORS: Record<Exclude<Theme, 'custom'>, RgbaColor> = {
  molten: { r: 255, g: 153, b: 0, a: 1 },
  grapefruit: { r: 255, g: 136, b: 98, a: 1 },
  taffy: { r: 165, g: 95, b: 255, a: 1 },
  bright: { r: 23, g: 105, b: 224, a: 1 },
};

const THEME_PRIMARY_LIGHT_COLORS: Record<Exclude<Theme, 'custom'>, RgbaColor> = {
  molten: { r: 255, g: 181, b: 69, a: 1 },
  grapefruit: { r: 255, g: 163, b: 130, a: 1 },
  taffy: { r: 183, g: 138, b: 255, a: 1 },
  bright: { r: 91, g: 156, b: 255, a: 1 },
};

export type CanvasBackgroundCustomColor = RgbaColor;

export const DEFAULT_CANVAS_BACKGROUND_CUSTOM_COLOR = 'rgba(40,44,52,1)';
export const DEFAULT_CUSTOM_THEME_PRIMARY_COLOR = 'rgba(255,153,0,1)';
const CSS_RGBA_COLOR_NUMBER_PATTERN = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';

export function resolveCanvasBackgroundPattern(value: unknown): CanvasBackgroundPattern {
  return canvasBackgroundPatterns.some((pattern) => pattern.value === value)
    ? (value as CanvasBackgroundPattern)
    : 'grid';
}

export function resolveCanvasBackgroundColorMode(value: unknown): CanvasBackgroundColorMode {
  if (value === 'grey' || value === 'greyBlue') {
    return 'theme';
  }

  return canvasBackgroundColorOptions.some((option) => option.value === value)
    ? (value as CanvasBackgroundColorMode)
    : 'theme';
}

export function parseCanvasBackgroundCustomColor(value: unknown): CanvasBackgroundCustomColor {
  return parseRgbaColor(value, { r: 40, g: 44, b: 52, a: 1 });
}

export function parseCustomThemePrimaryColor(value: unknown): RgbaColor {
  return parseRgbaColor(value, { r: 255, g: 153, b: 0, a: 1 });
}

export function parseCustomThemeSecondaryColor(value: unknown, fallbackValue: unknown): RgbaColor {
  return parseRgbaColor(value, parseCustomThemePrimaryColor(fallbackValue));
}

export function formatCustomThemePrimaryColor(color: RgbaColor): string {
  return formatRgbaColor(color);
}

export function formatCustomThemeSecondaryColor(color: RgbaColor): string {
  return formatRgbaColor(color);
}

export function normalizeCustomThemePrimaryColor(value: unknown): string {
  return formatCustomThemePrimaryColor(parseCustomThemePrimaryColor(value));
}

export function normalizeCustomThemeSecondaryColor(value: unknown, fallbackValue: unknown): string {
  return formatCustomThemeSecondaryColor(parseCustomThemeSecondaryColor(value, fallbackValue));
}

export function getCustomThemeCssVariables({
  primaryColor,
  secondaryColor,
}: {
  primaryColor: unknown;
  secondaryColor: unknown;
}): Record<'--custom-theme-primary' | '--custom-theme-secondary', string> {
  const normalizedPrimaryColor = normalizeCustomThemePrimaryColor(primaryColor);

  return {
    '--custom-theme-primary': normalizedPrimaryColor,
    '--custom-theme-secondary': normalizeCustomThemeSecondaryColor(secondaryColor, normalizedPrimaryColor),
  };
}

export function getThemeContrastCssVariables({
  theme,
  customThemePrimaryColor,
}: {
  theme: Theme | undefined;
  customThemePrimaryColor: unknown;
}): Record<'--foreground-on-primary' | '--foreground-on-primary-light', string> {
  const primaryColor =
    theme === 'custom'
      ? parseCustomThemePrimaryColor(customThemePrimaryColor)
      : THEME_PRIMARY_COLORS[theme ?? 'molten'] ?? THEME_PRIMARY_COLORS.molten;
  const primaryLightColor =
    theme === 'custom'
      ? mixRgbaColor(primaryColor, { r: 255, g: 255, b: 255, a: 1 }, 0.25)
      : THEME_PRIMARY_LIGHT_COLORS[theme ?? 'molten'] ?? THEME_PRIMARY_LIGHT_COLORS.molten;

  return {
    '--foreground-on-primary': getContrastingMonochromeColor(primaryColor),
    '--foreground-on-primary-light': getContrastingMonochromeColor(primaryLightColor),
  };
}

function mixRgbaColor(baseColor: RgbaColor, mixColor: RgbaColor, mixAmount: number): RgbaColor {
  const baseAmount = 1 - mixAmount;

  return {
    r: baseColor.r * baseAmount + mixColor.r * mixAmount,
    g: baseColor.g * baseAmount + mixColor.g * mixAmount,
    b: baseColor.b * baseAmount + mixColor.b * mixAmount,
    a: 1,
  };
}

function parseRgbaColor(value: unknown, fallback: RgbaColor): RgbaColor {
  if (typeof value !== 'string') {
    return fallback;
  }

  const match = new RegExp(
    `^rgba\\(\\s*(?<r>${CSS_RGBA_COLOR_NUMBER_PATTERN})\\s*,\\s*(?<g>${CSS_RGBA_COLOR_NUMBER_PATTERN})\\s*,\\s*(?<b>${CSS_RGBA_COLOR_NUMBER_PATTERN})\\s*,\\s*(?<a>${CSS_RGBA_COLOR_NUMBER_PATTERN})\\s*\\)$`,
    'i',
  ).exec(value);

  if (!match?.groups) {
    return fallback;
  }

  const groups = match.groups as { r: string; g: string; b: string; a: string };

  return {
    r: clampCssColorChannel(Number.parseFloat(groups.r)),
    g: clampCssColorChannel(Number.parseFloat(groups.g)),
    b: clampCssColorChannel(Number.parseFloat(groups.b)),
    a: clampCssAlpha(Number.parseFloat(groups.a)),
  };
}

export function formatCanvasBackgroundCustomColor(color: CanvasBackgroundCustomColor): string {
  return formatRgbaColor(color);
}

function formatRgbaColor(color: RgbaColor): string {
  return `rgba(${clampCssColorChannel(color.r)},${clampCssColorChannel(color.g)},${clampCssColorChannel(
    color.b,
  )},${clampCssAlpha(color.a)})`;
}

export function normalizeCanvasBackgroundCustomColor(value: unknown): string {
  return formatCanvasBackgroundCustomColor(parseCanvasBackgroundCustomColor(value));
}

export function getCanvasBackgroundColor({
  mode,
  customColor,
}: {
  mode: CanvasBackgroundColorMode;
  customColor: unknown;
}): string {
  if (mode === 'custom') {
    return normalizeCanvasBackgroundCustomColor(customColor);
  }

  return 'var(--canvas-background-theme-color)';
}

export const DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY = 0.02;
export const MIN_CANVAS_BACKGROUND_PATTERN_OPACITY = 0;
export const MAX_CANVAS_BACKGROUND_PATTERN_OPACITY = 0.12;
export const CANVAS_BACKGROUND_PATTERN_OPACITY_STEP = 0.005;

export function clampCanvasBackgroundPatternOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY;
  }

  return Math.min(MAX_CANVAS_BACKGROUND_PATTERN_OPACITY, Math.max(MIN_CANVAS_BACKGROUND_PATTERN_OPACITY, value));
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

export const canvasBackgroundColorModeState = atomWithStorage<CanvasBackgroundColorMode>(
  'canvasBackgroundColorMode',
  'theme',
  storage,
);

export const canvasBackgroundCustomColorState = atomWithStorage<string>(
  'canvasBackgroundCustomColor',
  DEFAULT_CANVAS_BACKGROUND_CUSTOM_COLOR,
  storage,
);

export const customThemePrimaryColorState = atomWithStorage<string>(
  'customThemePrimaryColor',
  DEFAULT_CUSTOM_THEME_PRIMARY_COLOR,
  storage,
);

export const customThemeSecondaryColorState = atomWithStorage<string | undefined>(
  'customThemeSecondaryColor',
  undefined,
  storage,
);

export const debuggerDefaultUrlState = atomWithStorage('debuggerDefaultUrl', 'ws://localhost:21888', storage);

function clampCssColorChannel(value: number): number {
  if (!Number.isFinite(value)) {
    return 40;
  }

  return Math.min(255, Math.max(0, Math.round(value)));
}

function clampCssAlpha(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, Number(value.toFixed(3))));
}
