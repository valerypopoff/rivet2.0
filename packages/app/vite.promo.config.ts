import { defineConfig, mergeConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRivetViteConfig } from './vite.config.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) =>
  mergeConfig(createRivetViteConfig({ reactDevTools: false }), {
    root: resolve(appDirectory, 'promo'),
    // Docusaurus serves directory indexes from their no-trailing-slash URL.
    // An explicit build base keeps Vite assets inside the promo directory in
    // both that preview and GitHub Pages. Development still runs at Vite root.
    base: command === 'build' ? process.env.RIVET_PROMO_BASE_URL ?? '/rivet2.0/rivet-demo/' : '/',
    publicDir: false,
    build: {
      // Keep this relative to `root`: vite-plugin-monaco-editor joins the two
      // paths itself and cannot handle an absolute Windows outDir.
      outDir: '../../docs/build/rivet-demo',
      emptyOutDir: true,
    },
  }),
);
