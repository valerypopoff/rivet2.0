import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const platformDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(platformDir, '..', '..', '..');

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
