import {
  getLatestWebAppsBasePath,
  getLatestWorkflowsBasePath,
  getPublishedWebAppsBasePath,
  getPublishedWorkflowsBasePath,
} from './public-route-settings.js';

export { getLatestWebAppsBasePath, getLatestWorkflowsBasePath, getPublishedWebAppsBasePath, getPublishedWorkflowsBasePath };

export const PUBLISHED_WORKFLOWS_BASE_PATH = getPublishedWorkflowsBasePath();

export const LATEST_WORKFLOWS_BASE_PATH = getLatestWorkflowsBasePath();

export const RIVET_WEB_APPS_BASE_PATH = getPublishedWebAppsBasePath();

export const RIVET_LATEST_WEB_APPS_BASE_PATH = getLatestWebAppsBasePath();
