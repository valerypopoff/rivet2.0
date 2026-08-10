import { defineConfig, splitVendorChunkPlugin } from 'vite';
import type { PluginOption, UserConfig } from 'vite';
import react from '@vitejs/plugin-react';
import viteTsconfigPaths from 'vite-tsconfig-paths';
import svgr from 'vite-plugin-svgr';
import topLevelAwait from 'vite-plugin-top-level-await';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { visualizer } from 'rollup-plugin-visualizer';

const analyzeBundle = process.env.RIVET_BUNDLE_ANALYZE === 'true';
const require = createRequire(import.meta.url);
const appDirectory = dirname(fileURLToPath(import.meta.url));
const dictionaryEnBrowserModuleId = '\0rivet-dictionary-en-browser';
const cspellWordsBrowserModuleId = '\0rivet-cspell-words-browser';
const cspellSoftwareTermFiles = [
  'dict/softwareTerms.txt.gz',
  'dict/software-tools.txt',
  'dict/networkingTerms.txt',
  'dict/webServices.txt',
  'dict/computing-acronyms.txt',
  'dict/coding-compound-terms.txt',
  'dict/software-terms-alternative.txt',
];
const tauriApiOptimizeDepsExcludes = [
  '@tauri-apps/api',
  '@tauri-apps/api/app',
  '@tauri-apps/api/dialog',
  '@tauri-apps/api/fs',
  '@tauri-apps/api/globalShortcut',
  '@tauri-apps/api/http',
  '@tauri-apps/api/path',
  '@tauri-apps/api/process',
  '@tauri-apps/api/shell',
  '@tauri-apps/api/tauri',
  '@tauri-apps/api/window',
];
const monacoJsonOptimizeDepsIncludes = [
  'monaco-editor/esm/vs/language/json/monaco.contribution.js',
  'monaco-editor/esm/vs/language/json/jsonMode.js',
];

const reactDevTools = (): PluginOption => {
  return {
    name: 'react-devtools',
    apply: 'serve', // Only apply this plugin during development
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'script',
            attrs: {
              src: 'http://localhost:8097',
            },
            injectTo: 'head',
          },
        ],
      };
    },
  };
};

const dictionaryEnBrowserPlugin = (): PluginOption => ({
  name: 'rivet-dictionary-en-browser',
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

    const dictionaryDir = dirname(require.resolve('dictionary-en'));
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
  name: 'rivet-cspell-words-browser',
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

    const softwareTermsDir = dirname(require.resolve('@cspell/dict-software-terms/cspell-ext.json'));
    const companiesDir = dirname(require.resolve('@cspell/dict-companies/cspell-ext.json'));
    const words = new Set([
      ...cspellSoftwareTermFiles.flatMap((fileName) =>
        parseCspellDictionaryWords(readCspellDictionaryFile(softwareTermsDir, fileName)),
      ),
      ...parseCspellDictionaryWords(readCspellDictionaryFile(companiesDir, 'dict/companies.txt')),
    ]);

    return `export default ${JSON.stringify([...words])};`;
  },
});

export type RivetViteConfigOptions = {
  reactDevTools?: boolean;
};

// https://vitejs.dev/config/
export function createRivetViteConfig(options: RivetViteConfigOptions = {}): UserConfig {
  const enableReactDevTools = options.reactDevTools ?? true;

  return {
    optimizeDeps: {
      // Monaco registers JSON support lazily. Pre-bundle both sides of that
      // loader so opening a JSON-backed node editor cannot trigger Vite's
      // dependency re-optimization and leave the live page with a stale 504
      // `?v=` import URL.
      include: ['nspell', ...monacoJsonOptimizeDepsIncludes],
      exclude: [
        '@valerypopoff/rivet2-core',
        '@valerypopoff/trivet',
        'dictionary-en',
        'rivet-cspell-words',
        ...tauriApiOptimizeDepsExcludes,
      ],
    },
    resolve: {
      preserveSymlinks: true,

      alias: [
        {
          find: '@valerypopoff/rivet2-core/web-app-runtime',
          replacement: resolve(appDirectory, '../core/src/webAppRuntime.ts'),
        },
        {
          find: /^@valerypopoff\/rivet2-core$/,
          replacement: resolve(appDirectory, '../core/src/index.ts'),
        },
        { find: '@valerypopoff/trivet', replacement: resolve(appDirectory, '../trivet/src/index.ts') },
        {
          find: '@google-cloud/vertexai',
          replacement: resolve(appDirectory, './src/utils/browser/vertexAiBrowserStub.ts'),
        },
      ],
    },
    build: {
      chunkSizeWarningLimit: 10000,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('commonjsHelpers')) {
              return 'vendor';
            }

            if (id.includes('gpt-tokenizer')) {
              return 'gpt-tokenizer';
            }
          },
        },
        plugins: analyzeBundle ? [visualizer()] : [],
      },
    },
    plugins: [
      enableReactDevTools ? reactDevTools() : undefined,
      react(),
      viteTsconfigPaths(),
      svgr({
        svgrOptions: {
          icon: true,
        },
      }),
      dictionaryEnBrowserPlugin(),
      cspellWordsBrowserPlugin(),
      topLevelAwait(),
      splitVendorChunkPlugin(),
    ],
    worker: {
      format: 'es',
    },
  };
}

export default defineConfig(createRivetViteConfig());
