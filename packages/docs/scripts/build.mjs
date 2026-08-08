import { spawnRepositoryScript, spawnWorkspaceScript, waitForChild } from './workspace-command.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { baseUrl } = require('../docusaurus.config.js');
const promoBaseUrl = `${baseUrl.replace(/\/?$/, '/')}rivet-demo/`;

await waitForChild(spawnRepositoryScript('check:promo-catalog'), 'Rivet promo catalog check');
await waitForChild(spawnWorkspaceScript('@valerypopoff/rivet-app', 'check:promo-project'), 'Rivet promo project check');
await waitForChild(
  spawnWorkspaceScript('docs', 'build:site', {
    env: {
      NODE_ENV: 'production',
      RIVET_PROMO_DEMO_URL: '',
    },
  }),
  'Docusaurus build',
);
await waitForChild(
  spawnWorkspaceScript('@valerypopoff/rivet-app', 'build:promo', {
    env: {
      RIVET_PROMO_BASE_URL: promoBaseUrl,
      RIVET_PROMO_OUT_DIR: '../../docs/build/rivet-demo',
    },
  }),
  'Rivet promo build',
);
await waitForChild(spawnWorkspaceScript('docs', 'check:promo-bundle'), 'Rivet promo bundle check');
