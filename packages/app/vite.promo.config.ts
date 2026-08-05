import { defineConfig, mergeConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRivetViteConfig } from './vite.config.js';

const appDirectory = dirname(fileURLToPath(import.meta.url));
const defaultPromoOutDir = '../../docs/build/rivet-demo';

export default defineConfig(({ command }) =>
  mergeConfig(
    createRivetViteConfig({ reactDevTools: false }),
    {
      root: resolve(appDirectory, 'promo'),
      // Docusaurus serves directory indexes from their no-trailing-slash URL.
      // An explicit build base keeps built assets inside the promo directory
      // when Docusaurus serves them in development and on GitHub Pages. The
      // optional source-mode `dev:promo` command still runs at Vite root.
      base: command === 'build' ? process.env.RIVET_PROMO_BASE_URL ?? '/rivet2.0/rivet-demo/' : '/',
      publicDir: false,
      build: {
        outDir: process.env.RIVET_PROMO_OUT_DIR ?? defaultPromoOutDir,
        emptyOutDir: true,
      },
    },
  ),
);
