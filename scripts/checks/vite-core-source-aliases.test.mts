import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { rivetCoreSourceEntrypoints } from '../../packages/app/scripts/vite-core-source-aliases';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const coreDirectory = resolve(repoRoot, 'packages/core');
const appRequire = createRequire(resolve(repoRoot, 'packages/app/package.json'));
const viteModulePath = resolve(dirname(appRequire.resolve('vite/package.json')), 'dist/node/index.js');
const { loadConfigFromFile } = (await import(pathToFileURL(viteModulePath).href)) as {
  loadConfigFromFile: (
    environment: { command: 'build'; mode: string },
    configFile: string,
    configRoot: string,
  ) => Promise<{ config: UserConfig } | null>;
};

type Alias = {
  find: string | RegExp;
  replacement: string;
};

type AliasOptions = readonly Alias[] | Record<string, string>;

type UserConfig = {
  resolve?: {
    alias?: AliasOptions;
  };
};

function isAliasEntry(value: Alias | null | undefined): value is Alias {
  return value != null && typeof value === 'object' && 'find' in value && 'replacement' in value;
}

function normalizeAliases(aliases: AliasOptions | undefined): Alias[] {
  if (!aliases) {
    return [];
  }

  if (Array.isArray(aliases)) {
    return aliases.filter(isAliasEntry);
  }

  return Object.entries(aliases).map(([find, replacement]) => ({ find, replacement }));
}

function aliasMatchesSpecifier(alias: Alias, specifier: string): boolean {
  return typeof alias.find === 'string' ? alias.find === specifier : alias.find.test(specifier);
}

async function loadBuildConfig(relativeConfigPath: string): Promise<UserConfig> {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve(repoRoot, relativeConfigPath),
    repoRoot,
  );

  assert.ok(loaded, `Vite should load ${relativeConfigPath}`);
  return loaded.config;
}

for (const [label, configPath] of [
  ['App', 'packages/app/vite.config.ts'],
  ['hosted Studio Server', 'packages/studio-server-web/vite.config.ts'],
] as const) {
  test(`${label} Vite config consumes every shared Core source alias`, async () => {
    const config = await loadBuildConfig(configPath);
    const configuredAliases = normalizeAliases(config.resolve?.alias);

    for (const [specifier, sourcePath] of Object.entries(rivetCoreSourceEntrypoints)) {
      const matches = configuredAliases.filter((alias) => aliasMatchesSpecifier(alias, specifier));

      assert.equal(matches.length, 1, `${specifier} should have exactly one active alias in ${label}`);
      assert.equal(matches[0]?.replacement, resolve(coreDirectory, 'src', sourcePath));
    }
  });
}
