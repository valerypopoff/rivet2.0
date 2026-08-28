import { defineConfig, normalizePath } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import topLevelAwait from 'vite-plugin-top-level-await';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createBrowserSubpathAliases, createModuleOverrideAliases, createTauriShimAliases } from './vite-aliases';
import { replaceHostedProjectTabLabelExpression } from './project-tab-label-transform';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const workspaceRoot = resolve(__dirname, '../..');
const upstreamApp = resolve(__dirname, '../app');
const upstreamCore = resolve(__dirname, '../core');
const upstreamEvaluations = resolve(__dirname, '../evaluations');
const normalizedWorkspaceSourceRoots = [upstreamApp, upstreamCore, upstreamEvaluations].map((root) =>
  normalizePath(root),
);
const shimDir = resolve(__dirname, 'shims');
const overrideDir = resolve(__dirname, 'overrides');
const webDistDir = resolve(__dirname, 'dist');

const wrapperRequire = createRequire(resolve(__dirname, 'package.json'));
const upstreamAppRequire = createRequire(resolve(upstreamApp, 'package.json'));
const dictionaryEnBrowserModuleId = '\0hosted-rivet-dictionary-en-browser';
const cspellWordsBrowserModuleId = '\0hosted-rivet-cspell-words-browser';
const cspellSoftwareTermFiles = [
  'dict/softwareTerms.txt.gz',
  'dict/software-tools.txt',
  'dict/networkingTerms.txt',
  'dict/webServices.txt',
  'dict/computing-acronyms.txt',
  'dict/coding-compound-terms.txt',
  'dict/software-terms-alternative.txt',
];

const isBareImport = (specifier: string) => {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('\0') && !specifier.startsWith('virtual:');
};

const splitImportSuffix = (specifier: string) => {
  const match = /[?#]/.exec(specifier);

  if (!match || match.index === undefined) {
    return { path: specifier, suffix: '' };
  }

  return {
    path: specifier.slice(0, match.index),
    suffix: specifier.slice(match.index),
  };
};

const stripImportSuffix = (specifier: string) => splitImportSuffix(specifier).path;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const resolveWrapperPackageFile = (packageName: string, relativePath: string) => {
  let currentDir = dirname(wrapperRequire.resolve(packageName));

  while (currentDir !== dirname(currentDir)) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
      if (packageJson.name === packageName) {
        return resolve(currentDir, relativePath);
      }
    }
    currentDir = dirname(currentDir);
  }

  throw new Error(`Could not locate package root for ${packageName}`);
};

const wrapperPackageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
  dependencies?: Record<string, string>;
};
const hostedAppVersion = typeof wrapperPackageJson.version === 'string' && wrapperPackageJson.version.trim()
  ? wrapperPackageJson.version.trim()
  : 'unknown';
const upstreamSourcePackageAliases = new Set([
  '@valerypopoff/rivet-app',
  '@valerypopoff/rivet-studio-server-shared',
  '@valerypopoff/rivet2-core',
  '@valerypopoff/rivet2-evaluations',
]);

const wrapperAliasedDependencies = Object.keys(wrapperPackageJson.dependencies ?? {}).filter(
  (dependency) =>
    !upstreamSourcePackageAliases.has(dependency) &&
    !dependency.startsWith('@tauri-apps/') &&
    !dependency.startsWith('@types/') &&
    dependency !== 'assemblyai' &&
    dependency !== '@google/genai' &&
    dependency !== '@cspell/dict-companies' &&
    dependency !== '@cspell/dict-software-terms' &&
    dependency !== 'dictionary-en' &&
    dependency !== 'nanoid' &&
    dependency !== 'vite' &&
    !dependency.startsWith('@vitejs/') &&
    !dependency.startsWith('vite-'),
);

const resolveWrapperImport = (specifier: string) => {
  if (specifier === 'assemblyai') {
    return resolveWrapperPackageFile('assemblyai', 'dist/browser.mjs');
  }

  if (specifier === '@google/genai') {
    return resolveWrapperPackageFile('@google/genai', 'dist/web/index.mjs');
  }

  if (specifier === '@google-cloud/vertexai') {
    return resolve(__dirname, 'shims/google-cloud-vertexai.ts');
  }

  if (specifier === 'jsonpath-plus') {
    return resolveWrapperPackageFile('jsonpath-plus', 'dist/index-browser-esm.js');
  }

  if (specifier === 'yaml') {
    return resolveWrapperPackageFile('yaml', 'browser/index.js');
  }

  if (specifier === 'yaml/util') {
    return resolveWrapperPackageFile('yaml', 'browser/dist/util.js');
  }

  try {
    return wrapperRequire.resolve(specifier);
  } catch {
    const packageJsonPath = wrapperRequire.resolve(`${specifier}/package.json`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      module?: string;
      main?: string;
    };
    const entry = packageJson.module ?? packageJson.main ?? 'index.js';
    return resolve(packageJsonPath, '..', entry);
  }
};

const resolveUpstreamAppDependency = (specifier: string) => {
  try {
    return upstreamAppRequire.resolve(specifier);
  } catch {
    return wrapperRequire.resolve(specifier);
  }
};

const resolveWorkspaceSourceImport = (specifier: string, importer: string) => {
  const importerRequire = createRequire(importer);

  if (specifier === 'assemblyai') {
    return resolveWrapperPackageFile('assemblyai', 'dist/browser.mjs');
  }

  if (specifier === '@google/genai') {
    return resolveWrapperPackageFile('@google/genai', 'dist/web/index.mjs');
  }

  if (specifier === '@google-cloud/vertexai') {
    return resolve(__dirname, 'shims/google-cloud-vertexai.ts');
  }

  if (specifier === 'jsonpath-plus') {
    return resolveWrapperPackageFile('jsonpath-plus', 'dist/index-browser-esm.js');
  }

  if (specifier === 'yaml') {
    return resolveWrapperPackageFile('yaml', 'browser/index.js');
  }

  if (specifier === 'yaml/util') {
    return resolveWrapperPackageFile('yaml', 'browser/dist/util.js');
  }

  try {
    return importerRequire.resolve(specifier);
  } catch {
    return resolveWrapperImport(specifier);
  }
};

const wrapperExactDependencyAliases = wrapperAliasedDependencies.map((dependency) => ({
  find: new RegExp(`^${escapeRegExp(dependency)}$`),
  replacement: resolveWrapperImport(dependency),
}));

const browserSafeGoogleModule = resolve(overrideDir, 'core/plugins/google/google.ts');
const moduleOverrideAliases = createModuleOverrideAliases(overrideDir);
const normalizedUpstreamAppSrc = normalizePath(resolve(upstreamApp, 'src'));

const isRelativeImport = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');

const isUpstreamAppSourceImporter = (importer: string) => {
  const normalizedImporter = normalizePath(stripImportSuffix(importer));
  return normalizedImporter === normalizedUpstreamAppSrc || normalizedImporter.startsWith(`${normalizedUpstreamAppSrc}/`);
};

const resolveBrowserSafeGoogleCoreModule = (): PluginOption => ({
  name: 'resolve-browser-safe-google-core-module',
  async resolveId(source, importer) {
    if (!importer) {
      return null;
    }

    const normalizedImporter = normalizePath(importer);
    if (
      (source === '../google.js' || source === '../google.ts') &&
      normalizedImporter === normalizePath(resolve(upstreamCore, 'src/plugins/google/nodes/ChatGoogleNode.ts'))
    ) {
      return this.resolve(browserSafeGoogleModule, importer, { skipSelf: true });
    }

    return null;
  },
});

const resolveRivetModuleOverride = (): PluginOption => ({
  name: 'resolve-rivet-module-override',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!importer || !isRelativeImport(source) || !isUpstreamAppSourceImporter(importer)) {
      return null;
    }

    const override = moduleOverrideAliases.find((candidate) => candidate.find.test(source));
    if (!override) {
      return null;
    }

    return (await this.resolve(override.replacement, importer, { skipSelf: true })) ?? override.replacement;
  },
});

const normalizeHostedProjectTabLabels = (): PluginOption => {
  const projectSelectorPath = normalizePath(resolve(upstreamApp, 'src/components/ProjectSelector.tsx'));

  return {
    name: 'normalize-hosted-project-tab-labels',
    enforce: 'pre',
    transform(code, id) {
      if (normalizePath(stripImportSuffix(id)) !== projectSelectorPath) {
        return null;
      }

      const updatedCode = replaceHostedProjectTabLabelExpression(code);
      if (updatedCode == null) {
        return null;
      }

      return {
        code: updatedCode,
        map: null,
      };
    },
  };
};

const dictionaryEnBrowserPlugin = (): PluginOption => ({
  name: 'hosted-rivet-dictionary-en-browser',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'dictionary-en') {
      return dictionaryEnBrowserModuleId;
    }
  },
  load(id) {
    if (id !== dictionaryEnBrowserModuleId) {
      return;
    }

    const dictionaryDir = dirname(resolveUpstreamAppDependency('dictionary-en'));
    const dictionary = {
      aff: readFileSync(join(dictionaryDir, 'index.aff'), 'utf8'),
      dic: readFileSync(join(dictionaryDir, 'index.dic'), 'utf8'),
    };

    return `export default ${JSON.stringify(dictionary)};`;
  },
});

function readCspellDictionaryFile(dictionaryDir: string, fileName: string): string {
  const file = readFileSync(join(dictionaryDir, fileName));

  return fileName.endsWith('.gz') ? gunzipSync(file).toString('utf8') : file.toString('utf8');
}

function parseCspellDictionaryWords(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/^\*+|\*+$/g, '').toLowerCase())
    .filter((word) => /\p{L}/u.test(word) && !/\s/u.test(word));
}

const cspellWordsBrowserPlugin = (): PluginOption => ({
  name: 'hosted-rivet-cspell-words-browser',
  enforce: 'pre',
  resolveId(id) {
    if (id === 'rivet-cspell-words') {
      return cspellWordsBrowserModuleId;
    }
  },
  load(id) {
    if (id !== cspellWordsBrowserModuleId) {
      return;
    }

    const softwareTermsDir = dirname(resolveUpstreamAppDependency('@cspell/dict-software-terms/cspell-ext.json'));
    const companiesDir = dirname(resolveUpstreamAppDependency('@cspell/dict-companies/cspell-ext.json'));
    const words = new Set([
      ...cspellSoftwareTermFiles.flatMap((fileName) =>
        parseCspellDictionaryWords(readCspellDictionaryFile(softwareTermsDir, fileName)),
      ),
      ...parseCspellDictionaryWords(readCspellDictionaryFile(companiesDir, 'dict/companies.txt')),
    ]);

    return `export default ${JSON.stringify([...words])};`;
  },
});

const resolveWrapperDependency = (): PluginOption => ({
  name: 'resolve-wrapper-dependency',
  async resolveId(source, importer) {
    if (!importer || !isBareImport(source)) {
      return null;
    }

    const normalizedImporter = normalizePath(importer);
    if (!normalizedWorkspaceSourceRoots.some((root) => normalizedImporter.startsWith(root))) {
      return null;
    }

    if (upstreamSourcePackageAliases.has(source) || source.startsWith('@tauri-apps/')) {
      return null;
    }

    try {
      const { path, suffix } = splitImportSuffix(source);
      const resolved = resolveWorkspaceSourceImport(path, importer);
      return this.resolve(`${resolved}${suffix}`, importer, { skipSelf: true });
    } catch {
      return null;
    }
  },
});

export default defineConfig({
    root: __dirname,
    envDir: resolve(__dirname, '../..'),
    envPrefix: ['VITE_', 'RIVET_'],
    publicDir: resolve(upstreamApp, 'public'),

    optimizeDeps: {
      include: ['nspell'],
      exclude: ['@valerypopoff/rivet2-core', '@valerypopoff/rivet2-evaluations', 'dictionary-en', 'rivet-cspell-words'],
    },

    resolve: {
      preserveSymlinks: true,
      alias: [
        ...createTauriShimAliases(shimDir),
        ...wrapperExactDependencyAliases,
        {
          find: /^@gentrace\/core\/(.+)$/,
          replacement: resolveWrapperPackageFile('@gentrace/core', '$1'),
        },
        {
          find: /^github-markdown-css\/(.+)$/,
          replacement: resolveWrapperPackageFile('github-markdown-css', '$1'),
        },
        ...createBrowserSubpathAliases(__dirname, resolveWrapperPackageFile),
        {
          find: '@valerypopoff/rivet2-core/web-app-runtime',
          replacement: resolve(__dirname, '../core/src/webAppRuntime.ts'),
        },
        {
          find: /^@valerypopoff\/rivet2-core$/,
          replacement: resolve(__dirname, '../core/src/index.ts'),
        },
        {
          find: /^@valerypopoff\/rivet2-evaluations$/,
          replacement: resolve(__dirname, '../evaluations/src/index.ts'),
        },
      ],
    },

    define: {
      'import.meta.env.VITE_HOSTED_MODE': JSON.stringify('true'),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(hostedAppVersion),
    },

    build: {
      chunkSizeWarningLimit: 10000,
      outDir: webDistDir,
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('gpt-tokenizer')) {
              return 'gpt-tokenizer';
            }

            if (id.includes('monaco-editor')) {
              return 'monaco-editor';
            }

            if (id.includes('node_modules/react-dom')) {
              return 'react-dom';
            }

            if (id.includes('node_modules/@atlaskit/') || id.includes('node_modules/@emotion/')) {
              return 'atlaskit';
            }

            if (id.includes('node_modules/openai/')) {
              return 'openai';
            }
          },
        },
      },
    },

    plugins: [
      resolveBrowserSafeGoogleCoreModule(),
      resolveRivetModuleOverride(),
      normalizeHostedProjectTabLabels(),
      dictionaryEnBrowserPlugin(),
      cspellWordsBrowserPlugin(),
      resolveWrapperDependency(),
      react(),
      viteTsconfigPaths({ root: upstreamApp }),
      svgr({
        svgrOptions: {
          icon: true,
        },
      }),
      (monacoEditorPlugin as any).default({
        publicPath: 'monacoeditorwork',
        customDistPath: (_root: string, buildOutDir: string) => resolve(buildOutDir, 'monacoeditorwork'),
      }),
      topLevelAwait(),
    ],

    worker: {
      format: 'es',
    },

    server: {
      allowedHosts: true,
      fs: {
        // Dev mode imports shared Rivet source and workers from this workspace tree.
        strict: false,
        allow: [
          normalizePath(workspaceRoot),
          normalizePath('/workspace'),
          normalizePath(upstreamApp),
          normalizePath(upstreamCore),
          normalizePath(upstreamEvaluations),
        ],
      },
      port: 5174,
      watch: {
        usePolling: true,
        interval: 300,
      },
      proxy: {
        '/api': {
          target: 'http://localhost:3100',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:21889',
          ws: true,
          rewrite: (path) => path.replace(/^\/ws\/executor(\/internal)?/, ''),
        },
      },
    },
});
