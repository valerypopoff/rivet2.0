import { normalizeBasePath, normalizeBasePathFromAliases } from '../../shared/normalize-base-path.js';

export const PUBLISHED_WORKFLOWS_BASE_PATH = normalizeBasePath(
  process.env.RIVET_PUBLISHED_WORKFLOWS_BASE_PATH,
  '/workflows',
);

export const LATEST_WORKFLOWS_BASE_PATH = normalizeBasePath(
  process.env.RIVET_LATEST_WORKFLOWS_BASE_PATH,
  '/workflows-latest',
);

export const RIVET_WEB_APPS_BASE_PATH = normalizeBasePathFromAliases(
  [
    process.env.RIVET_PUBLISHED_APPS_BASE_PATH,
    process.env.RIVET_WEB_APPS_BASE_PATH,
  ],
  '/apps',
);

export const RIVET_LATEST_WEB_APPS_BASE_PATH = normalizeBasePathFromAliases(
  [
    process.env.RIVET_LATEST_APPS_BASE_PATH,
    process.env.RIVET_LATEST_WEB_APPS_BASE_PATH,
  ],
  '/apps-latest',
);
