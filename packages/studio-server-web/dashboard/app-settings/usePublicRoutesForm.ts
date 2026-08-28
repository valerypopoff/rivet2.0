import { type Dispatch, type SetStateAction, useState } from 'react';

import type { HostedRouteConfig } from '../types';
import { publicRouteSettingsResource } from '../appSettingsApi';
import { fetchHostedConfig } from '../workflowApi';
import {
  basePathToRouteSlug,
  createPublicRouteForm,
  publicRouteSettingsMatchConfig,
  type PublicRouteSettingsForm,
  type PublicRouteSettingsScope,
} from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

async function waitForHostedRouteConfig(settings: Parameters<typeof publicRouteSettingsMatchConfig>[0]) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const config = await fetchHostedConfig();
    if (publicRouteSettingsMatchConfig(settings, config)) {
      return config;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Route settings were saved, but the active route config has not updated yet.');
}

function mergeSavedForm(
  saved: PublicRouteSettingsForm,
  current: PublicRouteSettingsForm,
  scope: PublicRouteSettingsScope | null,
): PublicRouteSettingsForm {
  return scope === 'workflow-endpoints'
    ? {
        ...current,
        publishedWorkflowsSlug: saved.publishedWorkflowsSlug,
        latestWorkflowsSlug: saved.latestWorkflowsSlug,
      }
    : scope === 'web-apps'
      ? { ...current, publishedAppsSlug: saved.publishedAppsSlug, latestAppsSlug: saved.latestAppsSlug }
      : saved;
}

export function usePublicRoutesForm(
  enabled: boolean,
  routeConfig: HostedRouteConfig,
  onRouteConfigChange?: Dispatch<SetStateAction<HostedRouteConfig>>,
) {
  const [applying, setApplying] = useState(false);
  const resource = useSettingsFormResource({
    afterSave: async (settings) => {
      setApplying(true);
      try {
        const activeConfig = await waitForHostedRouteConfig(settings);
        onRouteConfigChange?.((current) => ({ ...current, ...activeConfig }));
      } finally {
        setApplying(false);
      }
    },
    defaultForm: {
      publishedWorkflowsSlug: basePathToRouteSlug(routeConfig.publishedWorkflowsBasePath),
      latestWorkflowsSlug: basePathToRouteSlug(routeConfig.latestWorkflowsBasePath),
      publishedAppsSlug: basePathToRouteSlug(routeConfig.publishedAppsBasePath),
      latestAppsSlug: basePathToRouteSlug(routeConfig.latestAppsBasePath),
    },
    enabled,
    mergeSavedForm,
    resource: publicRouteSettingsResource,
    toForm: createPublicRouteForm,
  });
  const changed = {
    webApps: (
      resource.form.publishedAppsSlug.trim() !== resource.baseline.publishedAppsSlug ||
      resource.form.latestAppsSlug.trim() !== resource.baseline.latestAppsSlug
    ),
    workflowEndpoints: (
      resource.form.publishedWorkflowsSlug.trim() !== resource.baseline.publishedWorkflowsSlug ||
      resource.form.latestWorkflowsSlug.trim() !== resource.baseline.latestWorkflowsSlug
    ),
  };

  const save = (scope: PublicRouteSettingsScope) => resource.save(
    scope === 'workflow-endpoints'
      ? {
          publishedWorkflowsBasePath: resource.form.publishedWorkflowsSlug.trim(),
          latestWorkflowsBasePath: resource.form.latestWorkflowsSlug.trim(),
        }
      : {
          publishedAppsBasePath: resource.form.publishedAppsSlug.trim(),
          latestAppsBasePath: resource.form.latestAppsSlug.trim(),
        },
    scope,
  );
  const revert = (scope: PublicRouteSettingsScope) => {
    resource.setForm((current) => mergeSavedForm(resource.baseline, current, scope));
    resource.clearFeedback();
  };

  return {
    ...resource,
    applying,
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving || applying,
    revert,
    save,
  };
}
