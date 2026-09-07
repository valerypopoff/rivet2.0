import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRivetCoreSourceAliases, rivetCoreSourceEntrypoints } from '../../../vite.core-source-aliases';
import { createRivetViteConfig } from '../../../vite.config';

const platformDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(platformDir, '..', '..', '..');

test('Vite source aliases cover every public Core package entrypoint', () => {
  const coreDirectory = resolve(appRoot, '../core');
  const corePackage = JSON.parse(readFileSync(resolve(coreDirectory, 'package.json'), 'utf8')) as {
    name: string;
    exports: Record<string, unknown>;
  };
  const exportedSpecifiers = Object.keys(corePackage.exports)
    .map((key) => (key === '.' ? corePackage.name : `${corePackage.name}/${key.slice(2)}`))
    .sort();

  assert.deepEqual(Object.keys(rivetCoreSourceEntrypoints).sort(), exportedSpecifiers);

  const sourceAliases = createRivetCoreSourceAliases(coreDirectory);
  const configuredAliases = createRivetViteConfig({ reactDevTools: false }).resolve?.alias;
  assert.ok(Array.isArray(configuredAliases), 'App Vite aliases should use array form');

  for (const [specifier, sourcePath] of Object.entries(rivetCoreSourceEntrypoints)) {
    const expectedReplacement = resolve(coreDirectory, 'src', sourcePath);
    const sourceMatches = sourceAliases.filter((alias) => alias.find.test(specifier));
    assert.equal(sourceMatches.length, 1, `${specifier} should have exactly one source alias`);
    assert.equal(sourceMatches[0]?.replacement, expectedReplacement);

    const configuredMatches = configuredAliases.filter(
      (alias) =>
        typeof alias === 'object' &&
        'find' in alias &&
        (typeof alias.find === 'string' ? alias.find === specifier : alias.find.test(specifier)),
    );
    assert.equal(configuredMatches.length, 1, `${specifier} should be active in the app Vite configuration`);
    assert.equal(configuredMatches[0]?.replacement, expectedReplacement);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectLazyTauriApiImports(): Set<string> {
  const imports = new Set<string>();

  for (const fileName of readdirSync(platformDir)) {
    if (!fileName.endsWith('.ts') || fileName.endsWith('.test.ts')) {
      continue;
    }

    const source = readFileSync(join(platformDir, fileName), 'utf8');
    for (const match of source.matchAll(/import\(['"](?<id>@tauri-apps\/api(?:\/[^'"]+)?)['"]\)/g)) {
      const id = match.groups?.id;
      if (id) {
        imports.add(id);
      }
    }
  }

  return imports;
}

test('Vite excludes lazy Tauri API imports from dependency optimization', () => {
  const viteConfigSource = readFileSync(join(appRoot, 'vite.config.ts'), 'utf8');
  const lazyTauriApiImports = collectLazyTauriApiImports();

  assert.ok(lazyTauriApiImports.size > 0, 'Expected lazy Tauri API imports to be discovered');

  for (const importId of lazyTauriApiImports) {
    assert.match(
      viteConfigSource,
      new RegExp(`['"]${escapeRegExp(importId)}['"]`),
      `${importId} should stay out of Vite optimizeDeps so native-only lazy imports do not depend on stale .vite/deps chunks`,
    );
  }
});

test('Vite resolves dictionary-en through a browser-safe virtual module', () => {
  const viteConfigSource = readFileSync(join(appRoot, 'vite.config.ts'), 'utf8');

  assert.match(viteConfigSource, /include: \[[^\]]*'nspell'/);
  assert.match(viteConfigSource, /const dictionaryEnBrowserPlugin = \(\): PluginOption =>/);
  assert.match(viteConfigSource, /exclude: \[[^\]]*'dictionary-en'/);
  assert.match(viteConfigSource, /enforce: 'pre'/);
  assert.match(viteConfigSource, /if \(id === 'dictionary-en'\)/);
  assert.match(viteConfigSource, /require\.resolve\('dictionary-en'\)/);
  assert.match(viteConfigSource, /readFileSync\(join\(dictionaryDir, 'index\.aff'\), 'utf8'\)/);
  assert.match(viteConfigSource, /readFileSync\(join\(dictionaryDir, 'index\.dic'\), 'utf8'\)/);
  assert.match(viteConfigSource, /JSON\.stringify\(dictionary\)/);
  assert.match(viteConfigSource, /dictionaryEnBrowserPlugin\(\),/);
});

test('Vite resolves CSpell dictionaries through a browser-safe word-list module', () => {
  const viteConfigSource = readFileSync(join(appRoot, 'vite.config.ts'), 'utf8');

  assert.match(viteConfigSource, /const cspellWordsBrowserPlugin = \(\): PluginOption =>/);
  assert.match(viteConfigSource, /if \(id === 'rivet-cspell-words'\)/);
  assert.match(viteConfigSource, /exclude: \[[\s\S]*'rivet-cspell-words'/);
  assert.match(viteConfigSource, /require\.resolve\('@cspell\/dict-software-terms\/cspell-ext\.json'\)/);
  assert.match(viteConfigSource, /require\.resolve\('@cspell\/dict-companies\/cspell-ext\.json'\)/);
  assert.match(viteConfigSource, /gunzipSync\(file\)\.toString\('utf8'\)/);
  assert.match(viteConfigSource, /parseCspellDictionaryWords/);
  assert.match(viteConfigSource, /cspellWordsBrowserPlugin\(\),/);
});
