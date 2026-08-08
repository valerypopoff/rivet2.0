import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from 'jotai/vanilla';
import {
  canvasBackgroundColorOptions,
  clearLegacyInvalidOpenAiApiKeyPlaceholder,
  clampCanvasBackgroundPatternOpacity,
  DEFAULT_CUSTOM_THEME_PRIMARY_COLOR,
  DEFAULT_ZOOM_SENSITIVITY,
  DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY,
  DEFAULT_CANVAS_BACKGROUND_CUSTOM_COLOR,
  formatCanvasBackgroundCustomColor,
  formatCustomThemePrimaryColor,
  formatCustomThemeSecondaryColor,
  getCanvasBackgroundColor,
  getCustomThemeCssVariables,
  getThemeContrastCssVariables,
  MAX_CANVAS_BACKGROUND_PATTERN_OPACITY,
  MIN_CANVAS_BACKGROUND_PATTERN_OPACITY,
  defaultExecutorState,
  getExecutorOptions,
  getStartupDefaultExecutor,
  normalizeCanvasBackgroundCustomColor,
  normalizeCustomThemePrimaryColor,
  normalizeCustomThemeSecondaryColor,
  parseCanvasBackgroundCustomColor,
  parseCustomThemePrimaryColor,
  parseCustomThemeSecondaryColor,
  resolveCanvasBackgroundColorMode,
  resolveCanvasBackgroundPattern,
  resolveEditorPreferences,
  selectedExecutorState,
  themes,
} from './settings.js';
import { memoryStorage } from './storage.js';

function restoreRecoilPersistStorage(previousStorage: unknown) {
  if (previousStorage === undefined) {
    memoryStorage.delete('recoil-persist');
  } else {
    memoryStorage.set('recoil-persist', previousStorage);
  }
}

test('resolveEditorPreferences applies editor defaults when settings are missing', () => {
  assert.deepEqual(resolveEditorPreferences(undefined), {
    applyDefaultNodeColors: true,
    openNodeSettingsOnCreate: true,
  });
  assert.deepEqual(resolveEditorPreferences({}), {
    applyDefaultNodeColors: true,
    openNodeSettingsOnCreate: true,
  });
});

test('default zoom sensitivity is the approximately 60 percent slider position', () => {
  assert.equal(DEFAULT_ZOOM_SENSITIVITY, 1.2);
});

test('clearLegacyInvalidOpenAiApiKeyPlaceholder only removes the known persisted placeholder', () => {
  const previousStorage = memoryStorage.get('recoil-persist');

  try {
    memoryStorage.set('recoil-persist', {
      ...(previousStorage ?? {}),
      settings: {
        openAiApiKey: 'admin@123',
        openAiKey: 'valid-legacy-key',
        anthropicApiKey: 'keep-me',
      },
    });

    assert.equal(clearLegacyInvalidOpenAiApiKeyPlaceholder(), true);
    assert.deepEqual(memoryStorage.get('recoil-persist')?.settings, {
      openAiApiKey: '',
      openAiKey: 'valid-legacy-key',
      anthropicApiKey: 'keep-me',
    });
    assert.equal(clearLegacyInvalidOpenAiApiKeyPlaceholder(), false);
  } finally {
    restoreRecoilPersistStorage(previousStorage);
  }
});

test('clearLegacyInvalidOpenAiApiKeyPlaceholder also clears the legacy OpenAI key alias', () => {
  const previousStorage = memoryStorage.get('recoil-persist');

  try {
    memoryStorage.set('recoil-persist', {
      ...(previousStorage ?? {}),
      settings: {
        openAiApiKey: 'valid-current-key',
        openAiKey: 'admin@123',
      },
    });

    assert.equal(clearLegacyInvalidOpenAiApiKeyPlaceholder(), true);
    assert.deepEqual(memoryStorage.get('recoil-persist')?.settings, {
      openAiApiKey: 'valid-current-key',
      openAiKey: '',
    });
  } finally {
    restoreRecoilPersistStorage(previousStorage);
  }
});

test('resolveEditorPreferences respects explicit editor settings', () => {
  assert.deepEqual(
    resolveEditorPreferences({
      defaultNodeColors: true,
      openNodeSettingsOnCreate: false,
    }),
    {
      applyDefaultNodeColors: true,
      openNodeSettingsOnCreate: false,
    },
  );
});

test('themes include a custom color theme', () => {
  assert.deepEqual(themes, [
    { label: 'Molten', value: 'molten' },
    { label: 'Grapefruit', value: 'grapefruit' },
    { label: 'Taffy', value: 'taffy' },
    { label: 'Bright', value: 'bright' },
    { label: 'Custom', value: 'custom' },
  ]);
});

test('selectedExecutorState snapshots the startup default after it is set', () => {
  const previousStorage = memoryStorage.get('recoil-persist');
  const store = createStore();

  try {
    store.set(defaultExecutorState, 'nodejs');
    assert.equal(store.get(selectedExecutorState), 'nodejs');

    store.set(selectedExecutorState, store.get(selectedExecutorState));
    store.set(defaultExecutorState, 'browser');

    assert.equal(store.get(selectedExecutorState), 'nodejs');
  } finally {
    restoreRecoilPersistStorage(previousStorage);
  }
});

test('selectedExecutorState reads the persisted startup default from preloaded storage', () => {
  const previousStorage = memoryStorage.get('recoil-persist');

  try {
    memoryStorage.set('recoil-persist', {
      ...(previousStorage ?? {}),
      defaultExecutor: 'nodejs',
    });

    const store = createStore();

    assert.equal(getStartupDefaultExecutor(), 'nodejs');
    assert.equal(store.get(selectedExecutorState), 'nodejs');
  } finally {
    restoreRecoilPersistStorage(previousStorage);
  }
});

test('selectedExecutorState falls back to Browser for invalid persisted startup defaults', () => {
  const previousStorage = memoryStorage.get('recoil-persist');

  try {
    memoryStorage.set('recoil-persist', {
      ...(previousStorage ?? {}),
      defaultExecutor: 'bad-executor',
    });

    const store = createStore();

    assert.equal(getStartupDefaultExecutor(), 'browser');
    assert.equal(store.get(selectedExecutorState), 'browser');
  } finally {
    restoreRecoilPersistStorage(previousStorage);
  }
});

test('getExecutorOptions exposes Node in desktop and hosted internal-executor shells', () => {
  assert.deepEqual(getExecutorOptions({ isDesktop: false, hasInternalExecutorUrl: false }), [
    { label: 'Browser', value: 'browser' },
  ]);

  assert.deepEqual(getExecutorOptions({ isDesktop: true, hasInternalExecutorUrl: false }), [
    { label: 'Browser', value: 'browser' },
    { label: 'Node', value: 'nodejs' },
  ]);

  assert.deepEqual(getExecutorOptions({ isDesktop: false, hasInternalExecutorUrl: true }), [
    { label: 'Browser', value: 'browser' },
    { label: 'Node', value: 'nodejs' },
  ]);
});

test('resolveCanvasBackgroundPattern falls back to grid for invalid stored values', () => {
  assert.equal(resolveCanvasBackgroundPattern('grid'), 'grid');
  assert.equal(resolveCanvasBackgroundPattern('dots'), 'dots');
  assert.equal(resolveCanvasBackgroundPattern('crosses'), 'crosses');
  assert.equal(resolveCanvasBackgroundPattern('bad-pattern'), 'grid');
  assert.equal(resolveCanvasBackgroundPattern(undefined), 'grid');
});

test('resolveCanvasBackgroundColorMode falls back to theme for invalid stored values', () => {
  assert.deepEqual(canvasBackgroundColorOptions, [
    { label: 'Theme', value: 'theme' },
    { label: 'Custom', value: 'custom' },
  ]);
  assert.equal(resolveCanvasBackgroundColorMode('theme'), 'theme');
  assert.equal(resolveCanvasBackgroundColorMode('greyBlue'), 'theme');
  assert.equal(resolveCanvasBackgroundColorMode('custom'), 'custom');
  assert.equal(resolveCanvasBackgroundColorMode('grey'), 'theme');
  assert.equal(resolveCanvasBackgroundColorMode('black'), 'theme');
  assert.equal(resolveCanvasBackgroundColorMode('bad-color'), 'theme');
  assert.equal(resolveCanvasBackgroundColorMode(undefined), 'theme');
});

test('canvas background custom color parsing produces safe rgba values', () => {
  assert.deepEqual(parseCanvasBackgroundCustomColor('rgba(10,20,30,0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseCanvasBackgroundCustomColor('rgba(999,-2,20,2)'), { r: 255, g: 0, b: 20, a: 1 });
  assert.equal(normalizeCanvasBackgroundCustomColor('rgba(12.4,20.6,30,0.33333)'), 'rgba(12,21,30,0.333)');
  assert.equal(normalizeCanvasBackgroundCustomColor('bad-color'), DEFAULT_CANVAS_BACKGROUND_CUSTOM_COLOR);
  assert.equal(formatCanvasBackgroundCustomColor({ r: 260, g: -1, b: 12.4, a: 1.2 }), 'rgba(255,0,12,1)');
});

test('custom theme color parsing produces safe rgba values and css variables', () => {
  assert.equal(DEFAULT_CUSTOM_THEME_PRIMARY_COLOR, 'rgba(255,153,0,1)');
  assert.deepEqual(parseCustomThemePrimaryColor('rgba(120,80,40,0.75)'), { r: 120, g: 80, b: 40, a: 0.75 });
  assert.deepEqual(parseCustomThemeSecondaryColor('rgba(30,60,90,0.5)', 'rgba(120,80,40,0.75)'), {
    r: 30,
    g: 60,
    b: 90,
    a: 0.5,
  });
  assert.deepEqual(parseCustomThemeSecondaryColor('bad-color', 'rgba(120,80,40,0.75)'), {
    r: 120,
    g: 80,
    b: 40,
    a: 0.75,
  });
  assert.equal(normalizeCustomThemePrimaryColor('rgba(12.4,20.6,30,0.33333)'), 'rgba(12,21,30,0.333)');
  assert.equal(normalizeCustomThemeSecondaryColor(undefined, 'rgba(12.4,20.6,30,0.33333)'), 'rgba(12,21,30,0.333)');
  assert.equal(normalizeCustomThemePrimaryColor('bad-color'), DEFAULT_CUSTOM_THEME_PRIMARY_COLOR);
  assert.equal(formatCustomThemePrimaryColor({ r: 260, g: -1, b: 12.4, a: 1.2 }), 'rgba(255,0,12,1)');
  assert.equal(formatCustomThemeSecondaryColor({ r: 1, g: 2, b: 300, a: -1 }), 'rgba(1,2,255,0)');
  assert.deepEqual(getCustomThemeCssVariables({ primaryColor: 'rgba(1,2,3,0.4)', secondaryColor: undefined }), {
    '--custom-theme-primary': 'rgba(1,2,3,0.4)',
    '--custom-theme-secondary': 'rgba(1,2,3,0.4)',
  });
  assert.deepEqual(getCustomThemeCssVariables({ primaryColor: 'rgba(1,2,3,0.4)', secondaryColor: 'rgba(9,8,7,0.6)' }), {
    '--custom-theme-primary': 'rgba(1,2,3,0.4)',
    '--custom-theme-secondary': 'rgba(9,8,7,0.6)',
  });
  assert.deepEqual(getCustomThemeCssVariables({ primaryColor: 'rgba(1,2,3,0.4)', secondaryColor: 'bad-color' }), {
    '--custom-theme-primary': 'rgba(1,2,3,0.4)',
    '--custom-theme-secondary': 'rgba(1,2,3,0.4)',
  });
});

test('theme contrast css variables choose readable foregrounds for primary accents', () => {
  assert.deepEqual(getThemeContrastCssVariables({ theme: 'molten', customThemePrimaryColor: undefined }), {
    '--foreground-on-primary': '#000',
    '--foreground-on-primary-light': '#000',
  });
  assert.deepEqual(getThemeContrastCssVariables({ theme: 'bright', customThemePrimaryColor: undefined }), {
    '--foreground-on-primary': '#fff',
    '--foreground-on-primary-light': '#000',
  });
  assert.deepEqual(getThemeContrastCssVariables({ theme: 'custom', customThemePrimaryColor: 'rgba(245,245,245,1)' }), {
    '--foreground-on-primary': '#000',
    '--foreground-on-primary-light': '#000',
  });
  assert.deepEqual(getThemeContrastCssVariables({ theme: 'custom', customThemePrimaryColor: 'rgba(20,20,20,1)' }), {
    '--foreground-on-primary': '#fff',
    '--foreground-on-primary-light': '#fff',
  });
});

test('getCanvasBackgroundColor resolves preset and custom canvas colors', () => {
  assert.equal(
    getCanvasBackgroundColor({ mode: 'theme', customColor: 'rgba(1,2,3,1)' }),
    'var(--canvas-background-theme-color)',
  );
  assert.equal(getCanvasBackgroundColor({ mode: 'custom', customColor: 'rgba(1,2,3,0.4)' }), 'rgba(1,2,3,0.4)');
});

test('clampCanvasBackgroundPatternOpacity keeps canvas pattern opacity in range', () => {
  assert.equal(clampCanvasBackgroundPatternOpacity(0.04), 0.04);
  assert.equal(clampCanvasBackgroundPatternOpacity(-1), MIN_CANVAS_BACKGROUND_PATTERN_OPACITY);
  assert.equal(clampCanvasBackgroundPatternOpacity(1), MAX_CANVAS_BACKGROUND_PATTERN_OPACITY);
  assert.equal(clampCanvasBackgroundPatternOpacity(Number.NaN), DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY);
  assert.equal(
    clampCanvasBackgroundPatternOpacity(Number.POSITIVE_INFINITY),
    DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY,
  );
  assert.equal(clampCanvasBackgroundPatternOpacity(null), DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY);
  assert.equal(clampCanvasBackgroundPatternOpacity('0.04'), DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY);
});
