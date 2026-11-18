import { expect, type Page } from '@playwright/test';

import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './hostedEditorObserve';
import type {
  HostedRouteConfig,
  WorkflowProjectItem,
  WorkflowProjectWebAppSummary,
  WorkflowPublishedVersionSummary,
  WorkflowTreeResponse,
} from '../../dashboard/types';

type ProjectSettingsRouteTrackers = {
  projectLoadRequests: Array<{ path: string }>;
  endpointPublishRequests: Array<{
    relativePath?: string;
    settings?: { endpointName?: string; expectedRevisionId?: string };
    preconditions?: {
      expectedProjectId?: string;
      expectedDraftRevisionId?: string;
      expectedPublicationVersion?: string;
    };
  }>;
  endpointAccessRequests: Array<{ relativePath: string; access: 'public' | 'internal' }>;
  webAppPublishRequests: Array<{
    relativePath: string;
    publications: Array<{ uiGraphId: string; slug: string; allowedEmails?: string[] }>;
  }>;
  webAppUnpublishRequests: Array<{ relativePath: string; uiGraphId: string }>;
  publishedVersionCommentRequests: Array<{ relativePath: string; versionId: string; comment: string }>;
  publishedVersionPreviewRequests: Array<{ relativePath: string; versionId: string }>;
  publishedVersionStarRequests: Array<{ relativePath: string; versionId: string; isStarred: boolean }>;
  publishedVersionRestoreRequests: Array<{ relativePath: string; versionId: string }>;
};

type ProjectSettingsFixtureProject = WorkflowProjectItem & {
  hasMainGraph?: boolean;
  webApps?: WorkflowProjectWebAppSummary[];
  savedLatestSubgraphProjectIds?: string[];
};

const DEFAULT_HOSTED_ROUTE_CONFIG: HostedRouteConfig = {
  executorWsUrl: 'ws://127.0.0.1:8081/ws/executor/internal',
  remoteDebuggerDefaultWs: 'ws://127.0.0.1:8081/ws/latest-debugger',
  publishedWorkflowsBasePath: '/workflows',
  latestWorkflowsBasePath: '/workflows-latest',
  publishedAppsBasePath: '/apps',
  latestAppsBasePath: '/apps-latest',
  webAppsAuthMode: 'ui-gate',
};

export function isRouteRequest(
  routeRequest: { method: () => string; url: () => string },
  method: string,
  pathname: string,
): boolean {
  const url = new URL(routeRequest.url());

  return routeRequest.method() === method && url.pathname === pathname;
}

export function createProjectSettingsRouteTrackers(): ProjectSettingsRouteTrackers {
  return {
    projectLoadRequests: [],
    endpointPublishRequests: [],
    endpointAccessRequests: [],
    webAppPublishRequests: [],
    webAppUnpublishRequests: [],
    publishedVersionCommentRequests: [],
    publishedVersionPreviewRequests: [],
    publishedVersionStarRequests: [],
    publishedVersionRestoreRequests: [],
  };
}

export function createProjectSettingsFixture(name: string): ProjectSettingsFixtureProject {
  return {
    id: `project-settings-fixture-${name}`,
    projectMetadataId: `project-settings-fixture-${name}`,
    revisionId: 'revision-1',
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-04-08T10:00:00.000Z',
    stats: {
      graphCount: 2,
      totalNodeCount: 7,
      webAppCount: 0,
    },
    settings: {
      status: 'unpublished',
      publicationVersion: '0',
      endpointName: '',
      lastPublishedAt: null,
      publishedWebApps: [],
    },
    webApps: [],
  };
}

function createPublishedVersionPreviewProject(project: WorkflowProjectItem, versionId: string): string {
  const graphId = `${versionId}-graph`;

  return [
    'version: 4',
    'data:',
    '  metadata:',
    `    id: ${JSON.stringify(project.id)}`,
    `    title: ${JSON.stringify(project.name)}`,
    '    description: ""',
    `    mainGraphId: ${JSON.stringify(graphId)}`,
    '  graphs:',
    `    ${JSON.stringify(graphId)}:`,
    '      metadata:',
    `        id: ${JSON.stringify(graphId)}`,
    '        name: "Main Graph"',
    '        description: ""',
    '      nodes: {}',
    '  plugins: []',
    '  references: []',
    '',
  ].join('\n');
}

export async function installProjectSettingsRoutes(
  page: Page,
  projectOrProjects: ProjectSettingsFixtureProject | ProjectSettingsFixtureProject[],
  trackers: ProjectSettingsRouteTrackers,
  options: {
    routeConfig?: Partial<HostedRouteConfig>;
    loseAcknowledgement?: 'publish' | 'restore';
    incompleteAcknowledgement?: 'publish' | 'restore';
  } = {},
): Promise<void> {
  await mockHostedEditorBootstrap(page);
  const projects = Array.isArray(projectOrProjects) ? projectOrProjects : [projectOrProjects];
  for (const candidate of projects) candidate.settings.publicationVersion ??= '0';
  const project = projects[0]!;
  await page.route('**/api/workflows/projects/references?**', async (route) => {
    await route.fulfill({
      json: {
        projectId: project.projectMetadataId,
        references: [],
        checkedProjects: 0,
        totalProjects: 0,
        complete: true,
        changedDuringScan: false,
        unreadableProjects: [],
      },
    });
  });
  const routeConfig = {
    ...DEFAULT_HOSTED_ROUTE_CONFIG,
    ...options.routeConfig,
  };
  const publishedVersions: WorkflowPublishedVersionSummary[] = Array.from({ length: 12 }, (_, index) => ({
    id: `published-version-${index + 1}`,
    projectId: project.id,
    projectName: project.name,
    endpointName: `codex-project-settings-endpoint-${index + 1}`,
    publishedAt: new Date(Date.UTC(2026, 3, 8, 10, 30 - index, 0)).toISOString(),
    isCurrent: false,
    isStarred: false,
    comment: '',
  }));
  const getPublishedVersions = () => {
    const endpointName = project.settings.publishedEndpointName || project.settings.endpointName || 'codex-project-settings-endpoint';
    return publishedVersions.map((version, index) => ({
      ...version,
      endpointName: index === 0 ? endpointName : `${endpointName}-${index + 1}`,
      isCurrent: index === 0 && project.settings.status !== 'unpublished',
    }));
  };
  const advancePublicationVersion = (target: ProjectSettingsFixtureProject) => {
    target.settings.publicationVersion = (BigInt(target.settings.publicationVersion ?? '0') + 1n).toString();
  };
  const preconditionsMatch = (
    target: ProjectSettingsFixtureProject,
    preconditions:
      | { expectedProjectId?: string; expectedDraftRevisionId?: string; expectedPublicationVersion?: string }
      | undefined,
    publishesDraft: boolean,
  ) =>
    preconditions?.expectedProjectId === target.projectMetadataId &&
    preconditions.expectedPublicationVersion === target.settings.publicationVersion &&
    (!publishesDraft || preconditions.expectedDraftRevisionId === target.revisionId);
  const rejectStale = async (route: {
    fulfill: (options: { status: number; contentType: string; body: string }) => Promise<void>;
  }) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Publishing failed because the project changed. Review the latest saved version before trying again.',
        code: 'publication_draft_changed',
      }),
    });
  };

  await page.route('**/api/config', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/config')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(routeConfig),
    });
  });

  await page.route('**/api/workflows/tree', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/tree')) {
      await route.fallback();
      return;
    }

    const tree: WorkflowTreeResponse = {
      root: '/managed/workflows',
      sync: { epoch: 'playwright-fixture', revision: 0 },
      folders: [],
      projects,
    };

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(tree),
    });
  });

  await page.route('**/api/workflows/projects/publish', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/publish')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
      settings?: { endpointName?: string; expectedRevisionId?: string };
      preconditions?: {
        expectedProjectId?: string;
        expectedDraftRevisionId?: string;
        expectedPublicationVersion?: string;
      };
    };
    trackers.endpointPublishRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    if (!preconditionsMatch(targetProject, requestBody.preconditions, true)) {
      await rejectStale(route);
      return;
    }
    targetProject.settings = {
      status: 'published',
      endpointName: requestBody.settings?.endpointName ?? targetProject.settings.endpointName,
      publishedEndpointName: requestBody.settings?.endpointName ?? targetProject.settings.endpointName,
      endpointAccess: targetProject.settings.endpointAccess ?? 'public',
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: targetProject.settings.publishedWebApps,
      publicationVersion: targetProject.settings.publicationVersion,
    };
    advancePublicationVersion(targetProject);
    if (options.loseAcknowledgement === 'publish') return route.abort('failed');
    if (options.incompleteAcknowledgement === 'publish') return route.fulfill({ json: {} });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project: targetProject }),
    });
  });

  await page.route('**/api/workflows/projects/unpublish', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/unpublish')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath?: string;
    };
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    if (
      !preconditionsMatch(
        targetProject,
        (route.request().postDataJSON() as { preconditions?: any }).preconditions,
        false,
      )
    ) {
      await rejectStale(route);
      return;
    }
    targetProject.settings = {
      status: 'unpublished',
      endpointName: targetProject.settings.endpointName,
      publishedEndpointName: '',
      endpointAccess: targetProject.settings.endpointAccess ?? 'public',
      lastPublishedAt: targetProject.settings.lastPublishedAt,
      publishedWebApps: targetProject.settings.publishedWebApps,
      publicationVersion: targetProject.settings.publicationVersion,
    };
    advancePublicationVersion(targetProject);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project: targetProject }),
    });
  });

  await page.route('**/api/workflows/projects/endpoint-access', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/endpoint-access')) {
      await route.fallback();
      return;
    }
    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      access: 'public' | 'internal';
      preconditions?: any;
    };
    trackers.endpointAccessRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    if (!preconditionsMatch(targetProject, requestBody.preconditions, false)) {
      await rejectStale(route);
      return;
    }
    targetProject.settings.endpointAccess = requestBody.access;
    advancePublicationVersion(targetProject);
    await route.fulfill({ json: { project: targetProject } });
  });

  await page.route('**/api/workflows/projects/web-apps**', async (route) => {
    if (!isRouteRequest(route.request(), 'GET', '/api/workflows/projects/web-apps')) {
      await route.fallback();
      return;
    }

    const relativePath = new URL(route.request().url()).searchParams.get('relativePath') ?? '';
    const targetProject = projects.find((candidate) => candidate.relativePath === relativePath) ?? project;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project: targetProject,
        projectId: targetProject.projectMetadataId,
        draftRevisionId: targetProject.revisionId,
        publicationVersion: targetProject.settings.publicationVersion,
        hasMainGraph: targetProject.hasMainGraph ?? true,
        savedLatestSubgraphProjectIds: targetProject.savedLatestSubgraphProjectIds ?? [],
        webApps: targetProject.webApps ?? [],
      }),
    });
  });

  await page.route('**/api/workflows/projects/web-apps/publish', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/web-apps/publish')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      publications: Array<{ uiGraphId: string; slug: string }>;
      preconditions?: {
        expectedProjectId?: string;
        expectedDraftRevisionId?: string;
        expectedPublicationVersion?: string;
      };
    };
    trackers.webAppPublishRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    if (!preconditionsMatch(targetProject, requestBody.preconditions, true)) {
      await rejectStale(route);
      return;
    }
    const publishedAt = '2026-04-08T10:35:00.000Z';
    targetProject.webApps = (targetProject.webApps ?? []).map((webApp) => {
      const publication = requestBody.publications.find((candidate) => candidate.uiGraphId === webApp.uiGraphId);
      if (!publication) {
        return webApp;
      }

      return {
        ...webApp,
        publishedSlug: publication.slug,
        publishedAt,
        status: 'published',
        allowedEmails: publication.allowedEmails ?? [],
      };
    });
    targetProject.settings = {
      ...targetProject.settings,
      publishedWebApps: targetProject.webApps
        .filter((webApp) => webApp.publishedSlug != null)
        .map((webApp) => ({
          uiGraphId: webApp.uiGraphId,
          uiGraphName: webApp.name,
          slug: webApp.publishedSlug!,
          publishedAt: webApp.publishedAt ?? publishedAt,
        })),
    };
    advancePublicationVersion(targetProject);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project: targetProject }),
    });
  });

  await page.route('**/api/workflows/projects/web-apps/unpublish', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/web-apps/unpublish')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      uiGraphId: string;
      preconditions?: { expectedProjectId?: string; expectedPublicationVersion?: string };
    };
    trackers.webAppUnpublishRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    if (!preconditionsMatch(targetProject, requestBody.preconditions, false)) {
      await rejectStale(route);
      return;
    }
    targetProject.webApps = (targetProject.webApps ?? [])
      .map((webApp) =>
        webApp.uiGraphId === requestBody.uiGraphId
          ? { ...webApp, publishedSlug: null, publishedAt: null, status: 'unpublished' }
          : webApp,
      )
      .filter((webApp) => !(webApp.isMissingFromProject && webApp.publishedSlug == null));
    targetProject.settings = {
      ...targetProject.settings,
      publishedWebApps: targetProject.settings.publishedWebApps.filter(
        (webApp) => webApp.uiGraphId !== requestBody.uiGraphId,
      ),
    };
    advancePublicationVersion(targetProject);

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project: targetProject }),
    });
  });

  await page.route('**/api/projects/load', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/projects/load')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      path: string;
    };
    trackers.projectLoadRequests.push(requestBody);
    const loaded = projects.find((candidate) => candidate.absolutePath === requestBody.path) ?? project;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createPublishedVersionPreviewProject(loaded, `live-${trackers.projectLoadRequests.length}`),
        datasetsContents: null,
        revisionId: `revision-${trackers.projectLoadRequests.length}`,
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions**', async (route) => {
    const request = route.request();

    if (!isRouteRequest(request, 'GET', '/api/workflows/projects/published-versions')) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        versions: getPublishedVersions(),
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/star', async (route) => {
    if (!isRouteRequest(route.request(), 'PATCH', '/api/workflows/projects/published-versions/star')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
      isStarred: boolean;
    };
    trackers.publishedVersionStarRequests.push(requestBody);
    const version = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    if (!version) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    version.isStarred = requestBody.isStarred;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: getPublishedVersions().find((candidate) => candidate.id === requestBody.versionId),
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/comment', async (route) => {
    if (!isRouteRequest(route.request(), 'PATCH', '/api/workflows/projects/published-versions/comment')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
      comment: string;
    };
    trackers.publishedVersionCommentRequests.push(requestBody);
    const version = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    if (!version) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    version.comment = requestBody.comment.trim();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: getPublishedVersions().find((candidate) => candidate.id === requestBody.versionId),
      }),
    });
  });

  await page.route('**/api/workflows/projects/endpoint-release-review', (route) =>
    route.fulfill({ contentType: 'application/json', body: 'null' }),
  );
  await page.route('**/api/workflows/projects/reference-overview', (route) =>
    route.fulfill({ contentType: 'application/json', body: 'null' }),
  );
  await page.route('**/api/workflows/projects/published-versions/preview-tree', async (route) => {
    const { versionId } = route.request().postDataJSON();
    const version = getPublishedVersions().find((entry) => entry.id === versionId);
    if (!version) return route.fulfill({ status: 404, json: { error: 'Published revision not found' } });
    await route.fulfill({ json: {
      coverage: 'project-only', rootArtifactId: versionId, endpointName: version.endpointName, publishedAt: version.publishedAt,
      projects: [{ artifactId: versionId, projectId: version.projectId, relativePath: project.relativePath,
        name: project.name, savedAt: version.publishedAt }],
      references: [],
    } });
  });

  await page.route('**/api/workflows/projects/published-versions/preview', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/published-versions/preview')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
    };
    trackers.publishedVersionPreviewRequests.push(requestBody);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createPublishedVersionPreviewProject(project, requestBody.versionId),
        datasetsContents: null,
      }),
    });
  });

  await page.route('**/api/workflows/projects/published-versions/restore', async (route) => {
    if (!isRouteRequest(route.request(), 'POST', '/api/workflows/projects/published-versions/restore')) {
      await route.fallback();
      return;
    }

    const requestBody = route.request().postDataJSON() as {
      relativePath: string;
      versionId: string;
      preconditions?: {
        expectedProjectId?: string;
        expectedDraftRevisionId?: string;
        expectedPublicationVersion?: string;
      };
    };
    trackers.publishedVersionRestoreRequests.push(requestBody);
    if (!preconditionsMatch(project, requestBody.preconditions, false)) {
      await rejectStale(route);
      return;
    }
    const sourceVersion = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    if (!sourceVersion) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Published version not found' }),
      });
      return;
    }

    publishedVersions.forEach((version) => {
      version.isCurrent = false;
    });
    const restoredVersion: WorkflowPublishedVersionSummary = {
      ...sourceVersion,
      id: `restored-${sourceVersion.id}`,
      endpointName: project.settings.publishedEndpointName || project.settings.endpointName,
      publishedAt: new Date(Date.UTC(2026, 3, 8, 11, 0, 0)).toISOString(),
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    publishedVersions.unshift(restoredVersion);
    project.settings = {
      ...project.settings,
      status: 'published',
      publishedEndpointName: restoredVersion.endpointName,
      lastPublishedAt: restoredVersion.publishedAt,
    };
    advancePublicationVersion(project);

    if (options.loseAcknowledgement === 'restore') return route.abort('failed');
    if (options.incompleteAcknowledgement === 'restore') return route.fulfill({ json: { project } });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project,
        version: getPublishedVersions().find((candidate) => candidate.id === restoredVersion.id),
      }),
    });
  });
}

export async function openProjectSettingsModal(page: Page, project: WorkflowProjectItem) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);
  return showProjectSettingsModal(page, project);
}

export async function showProjectSettingsModal(page: Page, project: WorkflowProjectItem) {
  const projectRow = page.locator('.project-row', { hasText: project.name });
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.click();
  await page.locator('.active-project-more-button').click();

  const modal = page.getByTestId('workflow-project-settings-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.project-settings-modal-title')).toHaveText(project.name);

  return { modal, projectRow };
}
