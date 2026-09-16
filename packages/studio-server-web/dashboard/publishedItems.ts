import type { HostedRouteConfig, WorkflowProjectItem, WorkflowProjectStatus } from './types';

export type PublishedItemStatus = Exclude<WorkflowProjectStatus, 'unpublished'>;

export type PublishedItem = {
  id: string;
  kind: 'endpoint' | 'web-app';
  label: string;
  project: WorkflowProjectItem;
  route: string;
  status: PublishedItemStatus;
};

function buildPublishedRoute(basePath: string, slug: string): string {
  return `${basePath.replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
}

export function getPublishedItems(
  projects: readonly WorkflowProjectItem[],
  routeConfig: HostedRouteConfig,
): PublishedItem[] {
  return projects
    .flatMap((project): PublishedItem[] => {
      const items: PublishedItem[] = [];
      const endpointName = project.settings.endpointName.trim();

      if (endpointName && project.settings.status !== 'unpublished') {
        items.push({
          id: `endpoint:${project.id}:${endpointName}`,
          kind: 'endpoint',
          label: endpointName,
          project,
          route: buildPublishedRoute(routeConfig.publishedWorkflowsBasePath, endpointName),
          status: project.settings.status,
        });
      }

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
