import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';

import { createModuleOverrideAliases } from '../vite-aliases';

const overrideDir = resolve('/repo/wrapper/web/overrides');
const updateCheckScript = readFileSync(new URL('../../../scripts/update-check.sh', import.meta.url), 'utf8');
const settingsOverride = readFileSync(new URL('../overrides/state/settings.ts', import.meta.url), 'utf8');

function replacementFor(source: string): string | null {
  const alias = createModuleOverrideAliases(overrideDir).find((candidate) => candidate.find.test(source));
  return alias?.replacement.replace(/\\/g, '/') ?? null;
}

function collectSettingsOverrideExports(sourceFile: string): Set<string> {
  const exports = new Set<string>();
  const namedExportPattern = /export\s+(?:const|function|type)\s+([A-Za-z_$][\w$]*)/g;

  for (const match of sourceFile.matchAll(namedExportPattern)) {
    exports.add(match[1]);
  }

  return exports;
}

test('module override aliases keep only wrapper-owned Rivet app seams', () => {
  assert.match(replacementFor('../state/savedGraphs') ?? '', /\/overrides\/state\/savedGraphs\.ts$/);
  assert.match(replacementFor('../hooks/useLoadProject') ?? '', /\/overrides\/hooks\/useLoadProject\.ts$/);
  assert.match(
    replacementFor('../hooks/useSyncCurrentStateIntoOpenedProjects') ?? '',
    /\/overrides\/hooks\/useSyncCurrentStateIntoOpenedProjects\.ts$/,
  );
  assert.match(replacementFor('../hooks/useCopyNodesHotkeys') ?? '', /\/overrides\/hooks\/useCopyNodesHotkeys\.ts$/);
  assert.match(replacementFor('../hooks/useWindowsHotkeysFix') ?? '', /\/overrides\/hooks\/useWindowsHotkeysFix\.tsx$/);

  for (const retiredOverride of [
    '../model/TauriProjectReferenceLoader',
    '../io/datasets',
    '../io/TauriIOProvider',
    '../utils/globals/ioProvider',
    '../hooks/useExecutorSession',
    '../hooks/useRemoteDebugger',
    '../hooks/useGraphExecutor',
    '../hooks/useRemoteExecutor',
    '../hooks/useSaveProject',
    '../hooks/useMenuCommands',
  ]) {
    assert.equal(replacementFor(retiredOverride), null, `${retiredOverride} should not be aliased`);
  }
});

test('upstream compatibility scanner watches every active module override target', () => {
  const aliasedOverrideTargets = createModuleOverrideAliases(overrideDir)
    .map((alias) => relative(overrideDir, alias.replacement).replace(/\\/g, '/'))
    .sort();

  for (const aliasedOverrideTarget of aliasedOverrideTargets) {
    assert.match(
      updateCheckScript,
      new RegExp(`"${aliasedOverrideTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
      `scripts/update-check.sh should watch upstream ${aliasedOverrideTarget}`,
    );
  }
});

test('settings override preserves the hosted canvas background settings surface', () => {
  const overrideExports = collectSettingsOverrideExports(settingsOverride);

  for (const exportName of [
    'canvasBackgroundPatternOpacityState',
    'canvasBackgroundPatternState',
    'canvasBackgroundPatterns',
    'CANVAS_BACKGROUND_PATTERN_OPACITY_STEP',
    'clampCanvasBackgroundPatternOpacity',
    'DEFAULT_CANVAS_BACKGROUND_PATTERN_OPACITY',
    'MAX_CANVAS_BACKGROUND_PATTERN_OPACITY',
    'MIN_CANVAS_BACKGROUND_PATTERN_OPACITY',
    'resolveCanvasBackgroundPattern',
  ]) {
    assert.equal(overrideExports.has(exportName), true, `wrapper settings override must export ${exportName}`);
  }
});
