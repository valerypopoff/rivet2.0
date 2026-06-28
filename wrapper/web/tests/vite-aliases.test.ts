import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';

import { createModuleOverrideAliases } from '../vite-aliases';
import { replaceHostedProjectTabLabelExpression } from '../project-tab-label-transform';

const overrideDir = resolve('/repo/wrapper/web/overrides');
const updateCheckScript = readFileSync(new URL('../../../scripts/update-check.sh', import.meta.url), 'utf8');
const settingsOverride = readFileSync(new URL('../overrides/state/settings.ts', import.meta.url), 'utf8');
const contextMenuOverride = readFileSync(new URL('../overrides/hooks/useContextMenu.ts', import.meta.url), 'utf8');
const loadProjectOverride = readFileSync(new URL('../overrides/hooks/useLoadProject.ts', import.meta.url), 'utf8');
const syncOpenedProjectsOverride = readFileSync(
  new URL('../overrides/hooks/useSyncCurrentStateIntoOpenedProjects.ts', import.meta.url),
  'utf8',
);

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

test('settings override delegates upstream settings and keeps hosted-only exports narrow', () => {
  const overrideExports = collectSettingsOverrideExports(settingsOverride);

  assert.match(settingsOverride, /export\s+\*\s+from\s+['"][^'"]*\/state\/settings\.js['"]/);
  assert.deepEqual([...overrideExports].sort(), ['debuggerDefaultUrlState', 'updateModalOpenState']);
  assert.match(settingsOverride, /RIVET_REMOTE_DEBUGGER_DEFAULT_WS/);
});

test('context menu override keeps upstream virtual anchor contract and hosted focus cleanup', () => {
  const floatingHookIndex = contextMenuOverride.indexOf('const { refs, floatingStyles, update } = useFloating');
  const virtualReferenceIndex = contextMenuOverride.indexOf('refs.setReference(createContextMenuVirtualElement');

  assert.ok(floatingHookIndex >= 0, 'context menu override should create floating refs before using them');
  assert.ok(virtualReferenceIndex > floatingHookIndex, 'context menu override should not read refs before useFloating runs');
  assert.match(contextMenuOverride, /createContextMenuVirtualElement/);
  assert.match(contextMenuOverride, /refs\.setReference\(createContextMenuVirtualElement\(event\.clientX, event\.clientY\)\)/);
  assert.match(contextMenuOverride, /const setFloatingMenu = useMergeRefs\(\[refs\.setFloating, contextMenuRef\]\);/);
  assert.match(contextMenuOverride, /setFloatingMenu,/);
  assert.match(contextMenuOverride, /blurContextMenuFocus\(\);/);
  assert.doesNotMatch(contextMenuOverride, /refs\.setReference\s*=/);
});

test('hosted opened-project overrides preserve upstream project executor mode contract', () => {
  assert.match(syncOpenedProjectsOverride, /resolveCurrentProjectExecutorMode/);
  assert.match(syncOpenedProjectsOverride, /executorMode:\s*currentExecutorMode/);
  assert.match(
    syncOpenedProjectsOverride,
    /projectExecutorModesEqual\(existingProject\?\.executorMode,\s*currentExecutorMode\)/,
  );
  assert.match(syncOpenedProjectsOverride, /useSyncCurrentStateIntoOpenedProjects\(\{ enabled = true \}/);
  assert.match(loadProjectOverride, /executorMode:\s*projectInfo\.executorMode/);
});

test('hosted project tab label transform handles legacy upstream labels', () => {
  const source = [
    '  const fileName = unsaved ? \'Unsaved\' : project.fsPath!.split(\'/\').pop();',
    "  const projectDisplayName = `${project?.title}${fileName ? ` [${fileName}]` : ''}`;",
  ].join('\n');

  assert.equal(
    replaceHostedProjectTabLabelExpression(source),
    "  const projectDisplayName = project?.title?.trim() || 'Untitled Project';",
  );
});

test('hosted project tab label transform handles active-only upstream labels', () => {
  const source = [
    "  const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
    '  const active = projectTabsSelected && currentProject.metadata.id === projectId;',
    "  const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
  ].join('\n');

  assert.equal(
    replaceHostedProjectTabLabelExpression(source),
    [
      '  const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      "  const projectDisplayName = project?.title?.trim() || 'Untitled Project';",
    ].join('\n'),
  );
});

test('hosted project tab label transform preserves preview tab state', () => {
  const source = [
    "  const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
    '  const active = projectTabsSelected && currentProject.metadata.id === projectId;',
    '  const preview = projectTabUi[projectId]?.preview === true;',
    "  const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
  ].join('\n');

  assert.equal(
    replaceHostedProjectTabLabelExpression(source),
    [
      '  const active = projectTabsSelected && currentProject.metadata.id === projectId;',
      '  const preview = projectTabUi[projectId]?.preview === true;',
      "  const projectDisplayName = project?.title?.trim() || 'Untitled Project';",
    ].join('\n'),
  );
});

test('hosted project tab label transform preserves opening-tab-aware active state', () => {
  const source = [
    "  const fileName = unsaved ? 'Unsaved' : project.fsPath!.split(/[\\\\/]/).pop();",
    '  const active = projectTabsSelected && selectedOpeningProjectTabId == null && currentProject.metadata.id === projectId;',
    '  const preview = projectTabUi[projectId]?.preview === true;',
    "  const projectDisplayName = active ? `${project?.title}${fileName ? ` [${fileName}]` : ''}` : project?.title;",
  ].join('\n');

  assert.equal(
    replaceHostedProjectTabLabelExpression(source),
    [
      '  const active = projectTabsSelected && selectedOpeningProjectTabId == null && currentProject.metadata.id === projectId;',
      '  const preview = projectTabUi[projectId]?.preview === true;',
      "  const projectDisplayName = project?.title?.trim() || 'Untitled Project';",
    ].join('\n'),
  );
});

test('hosted project tab label transform handles opening project tabs', () => {
  const source = [
    '  const fileName = openingTab.path?.split(/[\\\\/]/).pop();',
    "  const projectDisplayName = active ? `${openingTab.title}${fileName ? ` [${fileName}]` : ''}` : openingTab.title;",
  ].join('\n');

  assert.equal(
    replaceHostedProjectTabLabelExpression(source),
    "  const projectDisplayName = openingTab.title.trim() || 'Untitled Project';",
  );
});

test('hosted project tab label transform no-ops on unknown upstream labels', () => {
  assert.equal(replaceHostedProjectTabLabelExpression('const projectDisplayName = project?.title;'), null);
});
