import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';
import { loadConfigFromFile, type Plugin, type PluginOption, type UserConfig } from 'vite';

import { createBrowserSubpathAliases, createModuleOverrideAliases } from '../vite-aliases';

const overrideDir = resolve('/repo/packages/studio-server-web/overrides');
const updateCheckScript = readFileSync(
  new URL('../../../deploy/studio-server/scripts/update-check.sh', import.meta.url),
  'utf8',
);
let viteConfig: UserConfig;
let plugins: Plugin[];
const cacheDirectory = resolve('artifacts/vite-config-contract-cache');
before(async () => {
  const previous = process.env.HOSTED_VITE_CACHE_DIR;
  process.env.HOSTED_VITE_CACHE_DIR = `  ${cacheDirectory}  `;
  try {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      undefined,
      'silent',
    );
    assert.ok(loaded, 'The real hosted Vite configuration must load.');
    viteConfig = loaded.config;
    const flatten = async (option: PluginOption): Promise<Plugin[]> => {
      const plugin = await option;
      if (!plugin) return [];
      if (Array.isArray(plugin)) return (await Promise.all(plugin.map(flatten))).flat();
      return [plugin];
    };
    plugins = (await Promise.all((viteConfig.plugins ?? []).map(flatten))).flat();
  } finally {
    if (previous === undefined) delete process.env.HOSTED_VITE_CACHE_DIR;
    else process.env.HOSTED_VITE_CACHE_DIR = previous;
  }
});
const wrapperPackageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const upstreamCorePackageJson = JSON.parse(
  readFileSync(new URL('../../core/package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
};
const upstreamNodePackageJson = JSON.parse(
  readFileSync(new URL('../../node/package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>;
};
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
    '../hooks/useWindowsHotkeysFix',
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

test('hosted Vite plugins emit executable, browser-safe spellcheck dictionaries', async () => {
  assert.equal(viteConfig.cacheDir, cacheDirectory);
  assert.ok(viteConfig.optimizeDeps?.include?.includes('nspell'));
  for (const [name, specifier] of [
    ['hosted-rivet-dictionary-en-browser', 'dictionary-en'],
    ['hosted-rivet-cspell-words-browser', 'rivet-cspell-words'],
  ]) {
    const plugin = plugins.find((candidate) => candidate.name === name);
    assert.ok(plugin?.resolveId && plugin.load, `${specifier} must have a registered browser loader.`);
    const resolveId = typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId.handler;
    const load = typeof plugin.load === 'function' ? plugin.load : plugin.load.handler;
    // These plugins generate self-contained modules; no filesystem or Node
    // imports may be left for the browser to resolve.
    const id = await resolveId.call({} as never, specifier, undefined, { isEntry: false });
    assert.equal(typeof id, 'string');
    const code = await load.call({} as never, id as string);
    assert.equal(typeof code, 'string');
    const { default: dictionary } = await import(
      `data:text/javascript;base64,${Buffer.from(code as string).toString('base64')}`
    );
    if (specifier === 'dictionary-en') {
      assert.equal(typeof dictionary.aff, 'string');
      assert.match(dictionary.dic, /\bhello\b/i);
    } else {
      assert.ok(Array.isArray(dictionary));
      assert.ok(dictionary.includes('javascript'));
      assert.ok(dictionary.includes('microsoft'));
      assert.equal(new Set(dictionary).size, dictionary.length);
    }
    assert.equal(await resolveId.call({} as never, 'unrelated-package', undefined, { isEntry: false }), undefined);
    assert.equal(await load.call({} as never, 'unrelated-module'), undefined);
    assert.ok(viteConfig.optimizeDeps?.exclude?.includes(specifier));
  }
});

test('hosted Vite config mirrors upstream browser dependencies with provider subpath support', () => {
  assert.equal(
    wrapperPackageJson.dependencies?.['@gentrace/core'],
    upstreamCorePackageJson.dependencies?.['@gentrace/core'],
  );
  assert.equal(wrapperPackageJson.dependencies?.dompurify, upstreamNodePackageJson.dependencies?.dompurify);
  const aliases = viteConfig.resolve?.alias;
  assert.ok(Array.isArray(aliases));
  const source = '@gentrace/core/package.json';
  const alias = aliases.find((candidate) => candidate.find instanceof RegExp && candidate.find.test(source));
  assert.ok(alias, 'Provider subpaths must resolve through the hosted dependencies.');
  assert.ok(existsSync(source.replace(alias.find, alias.replacement)), 'The resolved provider subpath must exist.');
});

test('hosted Vite config resolves workspace-source Zod imports to the V4 API surface', () => {
  const zodAlias = createBrowserSubpathAliases(resolve('/repo/packages/studio-server-web')).find((alias) =>
    alias.find.test('zod'),
  );

  assert.match(zodAlias?.replacement.replace(/\\/g, '/') ?? '', /\/node_modules\/zod\/v4\/index\.js$/);
});

test('settings override delegates upstream settings and keeps hosted-only exports narrow', () => {
  const overrideExports = collectSettingsOverrideExports(settingsOverride);

  assert.match(settingsOverride, /export\s+\*\s+from\s+['"][^'"]*\/state\/settings\.js['"]/);
  assert.deepEqual([...overrideExports].sort(), ['debuggerDefaultUrlState', 'updateModalOpenState']);
  assert.match(settingsOverride, /RIVET_REMOTE_DEBUGGER_DEFAULT_WS/);
  assert.match(settingsOverride, /normalizeRuntimeWebSocketUrl/);
});

test('context menu override keeps upstream virtual anchor contract and hosted focus cleanup', () => {
  const floatingHookIndex = contextMenuOverride.indexOf('const { refs, floatingStyles, update } = useFloating');
  const virtualReferenceIndex = contextMenuOverride.indexOf('refs.setReference(createContextMenuVirtualElement');

  assert.ok(floatingHookIndex >= 0, 'context menu override should create floating refs before using them');
  assert.ok(
    virtualReferenceIndex > floatingHookIndex,
    'context menu override should not read refs before useFloating runs',
  );
  assert.match(contextMenuOverride, /createContextMenuVirtualElement/);
  assert.match(
    contextMenuOverride,
    /refs\.setReference\(createContextMenuVirtualElement\(event\.clientX, event\.clientY\)\)/,
  );
  assert.match(contextMenuOverride, /const setFloatingMenu = useMergeRefs\(\[refs\.setFloating, contextMenuRef\]\);/);
  assert.match(contextMenuOverride, /setFloatingMenu,/);
  assert.match(contextMenuOverride, /blurContextMenuFocus\(\);/);
  assert.doesNotMatch(contextMenuOverride, /refs\.setReference\s*=/);
});

test('hosted opened-project overrides preserve upstream project executor mode contract', () => {
  assert.match(syncOpenedProjectsOverride, /resolveCurrentProjectExecutorMode/);
  assert.match(syncOpenedProjectsOverride, /normalizeHostedProjectExecutorMode/);
  assert.match(syncOpenedProjectsOverride, /executorMode:\s*currentExecutorMode/);
  assert.match(
    syncOpenedProjectsOverride,
    /projectExecutorModesEqual\(existingProject\?\.executorMode,\s*currentExecutorMode\)/,
  );
  assert.match(syncOpenedProjectsOverride, /useSyncCurrentStateIntoOpenedProjects\(\{ enabled = true \}/);
  assert.match(loadProjectOverride, /useActivateOpenedProject/);
  assert.match(loadProjectOverride, /normalizeExecutorMode:\s*normalizeHostedProjectExecutorMode/);
  assert.match(syncOpenedProjectsOverride, /useSyncProjectDirtyState/);
});
