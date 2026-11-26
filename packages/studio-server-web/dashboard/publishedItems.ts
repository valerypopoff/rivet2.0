import type { HostedRouteConfig, WorkflowProjectItem, WorkflowProjectStatus } from './types';
import {
  getWorkflowProjectEndpointStatus,
  type WorkflowPublicationReferenceChanges,
} from './workflowProjectPublicationStatus';

export type PublishedItemStatus = Exclude<WorkflowProjectStatus, 'unpublished'>;

export type PublishedItem = {
  id: string;
  kind: 'endpoint' | 'web-app';
  label: string;
  project: WorkflowProjectItem;
  route: string;
  status: PublishedItemStatus;
};

export function buildPublishedRoute(basePath: string, slug: string): string {
  return `${basePath.replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
}

/** Shorten same-origin routes for display without disguising a different host. */
export function getPublishedRouteLabel(route: string, origin: string): string {
  try {
    const url = new URL(route, origin);
    return url.origin === origin ? `${url.pathname.replace(/^\//, '')}${url.search}${url.hash}` : url.href;
  } catch {
    return route;
  }
}

export function getPublishedEndpoint(
  project: WorkflowProjectItem,
  routeConfig: HostedRouteConfig,
  references?: WorkflowPublicationReferenceChanges,
): PublishedItem | null {
  const endpointName = (project.settings.publishedEndpointName || project.settings.endpointName).trim();
  const status = getWorkflowProjectEndpointStatus(project, references);
  if (!endpointName || status === 'unpublished') return null;
  return {
    id: `endpoint:${project.id}:${endpointName}`,
    kind: 'endpoint',
    label: endpointName,
    project,
    route: buildPublishedRoute(
      project.settings.endpointAccess === 'internal'
        ? routeConfig.internalPublishedWorkflowsBaseUrl || 'http://api/internal/workflows'
        : routeConfig.publishedWorkflowsBasePath,
      endpointName,
    ),
    status,
  };
}

export function getPublishedItems(
  projects: readonly WorkflowProjectItem[],
  routeConfig: HostedRouteConfig,
  references?: WorkflowPublicationReferenceChanges,
): PublishedItem[] {
  return projects
    .flatMap((project): PublishedItem[] => {
      const items: PublishedItem[] = [];
      const endpoint = getPublishedEndpoint(project, routeConfig, references);
      if (endpoint) items.push(endpoint);

      for (const webApp of project.settings.publishedWebApps) {
        items.push({
          id: `web-app:${project.id}:${webApp.uiGraphId}`,
          kind: 'web-app',
          label: webApp.uiGraphName,
          project,
          route: buildPublishedRoute(routeConfig.publishedAppsBasePath, webApp.slug),
          status: webApp.status === 'unpublished_changes' ? 'unpublished_changes' : 'published',
        });
      }

      return items;
    })
    .sort(
      (left, right) =>
        left.project.name.localeCompare(right.project.name) ||
        left.kind.localeCompare(right.kind) ||
        left.label.localeCompare(right.label),
    );
}
