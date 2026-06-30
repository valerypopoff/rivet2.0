import { expect, test, type Page } from '@playwright/test';

import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type {
  HostedRouteConfig,
  WorkflowProjectItem,
  WorkflowProjectWebAppSummary,
  WorkflowPublishedVersionSummary,
  WorkflowTreeResponse,
} from '../dashboard/types';

type ProjectSettingsRouteTrackers = {
  projectLoadRequests: Array<{ path: string }>;
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
  webApps?: WorkflowProjectWebAppSummary[];
};

const DEFAULT_HOSTED_ROUTE_CONFIG: HostedRouteConfig = {
  publishedWorkflowsBasePath: '/workflows',
  latestWorkflowsBasePath: '/workflows-latest',
  publishedAppsBasePath: '/apps',
  latestAppsBasePath: '/apps-latest',
  webAppsAuthMode: 'ui-gate',
};

function isRouteRequest(routeRequest: { method: () => string; url: () => string }, method: string, pathname: string): boolean {
  const url = new URL(routeRequest.url());

  return routeRequest.method() === method && url.pathname === pathname;
}

function createProjectSettingsRouteTrackers(): ProjectSettingsRouteTrackers {
  return {
    projectLoadRequests: [],
    webAppPublishRequests: [],
    webAppUnpublishRequests: [],
    publishedVersionCommentRequests: [],
    publishedVersionPreviewRequests: [],
    publishedVersionStarRequests: [],
    publishedVersionRestoreRequests: [],
  };
}

function createProjectSettingsFixture(name: string): ProjectSettingsFixtureProject {
  return {
    id: `project-settings-fixture-${name}`,
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

async function installProjectSettingsRoutes(
  page: Page,
  projectOrProjects: ProjectSettingsFixtureProject | ProjectSettingsFixtureProject[],
  trackers: ProjectSettingsRouteTrackers,
  options: { routeConfig?: Partial<HostedRouteConfig> } = {},
): Promise<void> {
  const projects = Array.isArray(projectOrProjects) ? projectOrProjects : [projectOrProjects];
  const project = projects[0]!;
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
    const endpointName = project.settings.endpointName || 'codex-project-settings-endpoint';
    return publishedVersions.map((version, index) => ({
      ...version,
      endpointName: index === 0 ? endpointName : `${endpointName}-${index + 1}`,
      isCurrent: index === 0 && project.settings.status !== 'unpublished',
    }));
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
      settings?: { endpointName?: string };
    };
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    targetProject.settings = {
      status: 'published',
      endpointName: requestBody.settings?.endpointName ?? targetProject.settings.endpointName,
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: targetProject.settings.publishedWebApps,
    };
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
    targetProject.settings = {
      status: 'unpublished',
      endpointName: targetProject.settings.endpointName,
      lastPublishedAt: targetProject.settings.lastPublishedAt,
      publishedWebApps: targetProject.settings.publishedWebApps,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project: targetProject }),
    });
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
    };
    trackers.webAppPublishRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
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
    };
    trackers.webAppUnpublishRequests.push(requestBody);
    const targetProject = projects.find((candidate) => candidate.relativePath === requestBody.relativePath) ?? project;
    targetProject.webApps = (targetProject.webApps ?? [])
      .map((webApp) => webApp.uiGraphId === requestBody.uiGraphId
        ? { ...webApp, publishedSlug: null, publishedAt: null, status: 'unpublished' }
        : webApp)
      .filter((webApp) => !(webApp.isMissingFromProject && webApp.publishedSlug == null));
    targetProject.settings = {
      ...targetProject.settings,
      publishedWebApps: targetProject.settings.publishedWebApps.filter((webApp) => webApp.uiGraphId !== requestBody.uiGraphId),
    };

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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: createPublishedVersionPreviewProject(project, `live-${trackers.projectLoadRequests.length}`),
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
    };
    trackers.publishedVersionRestoreRequests.push(requestBody);
    const sourceVersion = publishedVersions.find((candidate) => candidate.id === requestBody.versionId);
    const sourceSummary = getPublishedVersions().find((candidate) => candidate.id === requestBody.versionId);
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
      endpointName: sourceSummary?.endpointName ?? sourceVersion.endpointName,
      publishedAt: new Date(Date.UTC(2026, 3, 8, 11, 0, 0)).toISOString(),
      isCurrent: true,
      isStarred: false,
      comment: '',
    };
    publishedVersions.unshift(restoredVersion);
    project.settings = {
      status: 'published',
      endpointName: restoredVersion.endpointName,
      lastPublishedAt: restoredVersion.publishedAt,
      publishedWebApps: project.settings.publishedWebApps,
    };

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

async function openProjectSettingsModal(page: Page, project: WorkflowProjectItem) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await authenticateIfNeeded(page);
  await waitForDashboardReady(page);

  const projectRow = page.locator('.project-row', { hasText: project.name });
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const modal = page.getByTestId('workflow-project-settings-modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.project-settings-modal-title')).toHaveText(project.name);

  return { modal, projectRow };
}

test.describe('Project settings modal', () => {
  test('publish controls validate endpoints and keep rename/delete ownership clear', async ({ page }) => {
    const unique = 'codex-project-settings-fixture';
    const endpointName = 'codex-project-settings-endpoint';
    const project = createProjectSettingsFixture(unique);
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());

    const { modal } = await openProjectSettingsModal(page, project);
    const activeProjectSection = page.locator('.active-project-section');
    await expect(activeProjectSection.locator('.active-project-details > :first-child')).toHaveClass(/active-project-name-row/);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(unique);
    const activeProjectStatusLines = activeProjectSection.locator('.active-project-status-line');
    await expect(activeProjectStatusLines).toHaveCount(2);
    await expect(activeProjectStatusLines.first()).toContainText('Endpoint:');
    await expect(activeProjectStatusLines.nth(1)).toContainText('Web app:');
    await expect(activeProjectStatusLines.nth(1).locator('.active-project-status-text')).toHaveText('none');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('2 graphs, 7 nodes');
    await expect(modal.getByRole('button', { name: 'Rename project' })).toHaveCount(0);
    await expect(modal.locator('.project-settings-title-input input')).toHaveCount(0);

    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
    const footerSection = modal.locator('.project-settings-danger-section');
    await expect(footerSection.getByRole('button', { name: 'Published version history' })).toBeVisible();
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(modal).toContainText('No web apps in the project.');
    await expect(footerSection.getByRole('button', { name: 'Published version history' })).toHaveCount(0);
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
    await modal.getByRole('tab', { name: 'Endpoint' }).click();
    await expect(footerSection.getByRole('button', { name: 'Published version history' })).toBeVisible();

    const endpointInput = modal.locator('#workflow-project-endpoint-name');
    await expect(endpointInput).toBeVisible();
    await expect(modal.locator('.active-project-status-row')).toContainText('Workflow is not published as endpoint.');
    const unpublishedStatusNoteFontSize = await modal.locator('.project-settings-status-note').evaluate(
      (element) => getComputedStyle(element).fontSize,
    );
    const unpublishedStatusNoteCenterOffset = await modal.locator('.active-project-status-row').evaluate((row) => {
      const badge = row.querySelector('.project-status-badge');
      const note = row.querySelector('.project-settings-status-note');
      if (!(badge instanceof HTMLElement) || !(note instanceof HTMLElement)) {
        throw new Error('Expected unpublished workflow status badge and note');
      }

      const badgeRect = badge.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      return Math.abs((badgeRect.top + badgeRect.height / 2) - (noteRect.top + noteRect.height / 2));
    });
    await expect(modal.getByText('Endpoint path')).toHaveCount(0);

    await endpointInput.fill('bad endpoint');
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await expect(modal.locator('.project-settings-error')).toContainText(
      'Endpoint name must contain only letters, numbers, and hyphens.',
    );

    await endpointInput.fill(endpointName);
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await expect(modal.locator('.project-settings-last-published-at')).toBeVisible();
    const lastPublishedAtFontSize = await modal.locator('.project-settings-last-published-at').evaluate(
      (element) => getComputedStyle(element).fontSize,
    );
    expect(lastPublishedAtFontSize).toBe(unpublishedStatusNoteFontSize);
    const lastPublishedAtCenterOffset = await modal.locator('.active-project-status-row').evaluate((row) => {
      const badge = row.querySelector('.project-status-badge');
      const timestamp = row.querySelector('.project-settings-last-published-at');
      if (!(badge instanceof HTMLElement) || !(timestamp instanceof HTMLElement)) {
        throw new Error('Expected published workflow status badge and timestamp');
      }

      const badgeRect = badge.getBoundingClientRect();
      const timestampRect = timestamp.getBoundingClientRect();
      return Math.abs((badgeRect.top + badgeRect.height / 2) - (timestampRect.top + timestampRect.height / 2));
    });
    expect(Math.abs(lastPublishedAtCenterOffset - unpublishedStatusNoteCenterOffset)).toBeLessThanOrEqual(1);
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await endpointInput.fill(`${endpointName}-renamed`);
    await expect(modal.locator('.project-settings-status-help')).toContainText(`/workflows/${endpointName}`);
    await expect(modal.locator('.project-settings-status-help')).not.toContainText(`/workflows/${endpointName}-renamed`);
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await endpointInput.fill(endpointName);
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Unpublish' })).toHaveCSS('margin-left', '8px');
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeDisabled();

    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Unpublish' }).click();
    await expect(modal.locator('.project-status-badge.unpublished')).toBeVisible({ timeout: 30_000 });
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
  });

  test('publish validation ignores endpoints saved on fully unpublished projects', async ({ page }) => {
    const endpointName = 'codex-reusable-unpublished-endpoint';
    const previousProject = createProjectSettingsFixture('codex-previous-endpoint-owner');
    previousProject.settings = {
      status: 'published',
      endpointName,
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: previousProject.settings.publishedWebApps,
    };
    const nextProject = createProjectSettingsFixture('codex-next-endpoint-owner');
    await installProjectSettingsRoutes(page, [previousProject, nextProject], createProjectSettingsRouteTrackers());

    const { modal: previousModal } = await openProjectSettingsModal(page, previousProject);
    page.once('dialog', (dialog) => dialog.accept());
    await previousModal.getByRole('button', { name: 'Unpublish' }).click();
    await expect(previousModal.locator('.project-status-badge.unpublished')).toBeVisible({ timeout: 30_000 });
    expect(previousProject.settings.endpointName).toBe(endpointName);
    await previousModal.getByRole('button', { name: 'Close project settings' }).click();

    const { modal: nextModal } = await openProjectSettingsModal(page, nextProject);
    const endpointInput = nextModal.locator('#workflow-project-endpoint-name');
    await endpointInput.fill(endpointName);
    await expect(nextModal.locator('.project-settings-error')).toHaveCount(0);
    await expect(nextModal.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await nextModal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(nextModal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await expect(nextModal.locator('.project-settings-endpoint-code')).toContainText(endpointName);
  });

  test('publishes and unpublishes multiple web apps from project settings', async ({ page }) => {
    const unique = 'codex-project-settings-web-apps';
    const project = createProjectSettingsFixture(unique);
    project.webApps = [
      {
        uiGraphId: 'ui-graph-alpha',
        name: 'Alpha Helper',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
      {
        uiGraphId: 'ui-graph-beta',
        name: 'Beta Console',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
      {
        uiGraphId: 'ui-graph-gamma',
        name: 'Gamma Reporter',
        publishedSlug: 'gamma-reporter',
        publishedAt: '2026-04-08T10:25:00.000Z',
        status: 'unpublished_changes',
        isMissingFromProject: false,
      },
      {
        uiGraphId: 'ui-graph-stale',
        name: 'Legacy Tool',
        publishedSlug: 'legacy-tool',
        publishedAt: '2026-04-08T10:20:00.000Z',
        status: 'unpublished_changes',
        isMissingFromProject: true,
      },
    ];
    project.stats = {
      ...project.stats!,
      webAppCount: 3,
    };
    const routeTrackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, routeTrackers, {
      routeConfig: {
        publishedAppsBasePath: '/custom-apps',
        latestAppsBasePath: '/custom-apps-latest',
      },
    });

    const { modal } = await openProjectSettingsModal(page, project);
    const activeProjectSection = page.locator('.active-project-section');
    await expect(activeProjectSection.locator('.active-project-details > :first-child')).toHaveClass(/active-project-name-row/);
    await expect(activeProjectSection.locator('.active-project-status-line')).toHaveCount(2);
    await expect(activeProjectSection.locator('.active-project-status-line').nth(1)).toContainText('Web apps:');
    await expect(activeProjectSection.locator('.active-project-various-statuses')).toHaveText('various statuses');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('2 graphs, 7 nodes, 3 web apps');
    await expect(modal.getByRole('tab', { name: 'Endpoint' })).toHaveAttribute('aria-selected', 'true');
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(modal.getByRole('tab', { name: 'Web apps' })).toHaveAttribute('aria-selected', 'true');
    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await expect(deleteButton).toBeDisabled();

    const webAppSection = modal.locator('.project-settings-web-app-section');
    await expect(webAppSection.locator('.project-settings-web-app-row')).toHaveCount(4);
    await expect(webAppSection.getByText('Endpoint path')).toHaveCount(0);
    await expect(webAppSection).not.toContainText('No web apps are published.');
    await expect(webAppSection).toContainText('Alpha Helper');
    await expect(webAppSection).toContainText('Beta Console');
    await expect(webAppSection).toContainText('Gamma Reporter');
    await expect(webAppSection).toContainText('Legacy Tool');
    await expect(webAppSection).toContainText('still published from an older snapshot');

    const alphaRow = webAppSection.locator('.project-settings-web-app-row', { hasText: 'Alpha Helper' });
    const betaRow = webAppSection.locator('.project-settings-web-app-row', { hasText: 'Beta Console' });
    const gammaRow = webAppSection.locator('.project-settings-web-app-row', { hasText: 'Gamma Reporter' });
    const staleRow = webAppSection.locator('.project-settings-web-app-row', { hasText: 'Legacy Tool' });
    await expect(alphaRow.locator('.project-settings-web-app-state.unpublished')).toHaveText('Not published');
    await expect(gammaRow.locator('.project-settings-web-app-state.unpublished_changes')).toHaveText('Unpublished changes');
    await expect(staleRow.locator('.project-settings-web-app-state.unpublished_changes')).toHaveText('Unpublished changes');
    await expect(gammaRow.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(gammaRow).toContainText('/custom-apps/gamma-reporter');
    await expect(gammaRow).toContainText('/custom-apps-latest/gamma-reporter');
    await expect(staleRow).toContainText('/custom-apps/legacy-tool');
    await expect(staleRow).not.toContainText('/custom-apps-latest/legacy-tool');
    await gammaRow.getByRole('button', { name: 'Update', exact: true }).click();
    await expect.poll(() => routeTrackers.webAppPublishRequests.length).toBe(1);
    expect(routeTrackers.webAppPublishRequests[0]).toEqual({
      relativePath: project.relativePath,
      publications: [
        { uiGraphId: 'ui-graph-gamma', slug: 'gamma-reporter', allowedEmails: [] },
      ],
    });
    await expect(gammaRow.locator('.project-settings-web-app-state.published')).toHaveText('Published');
    await expect(gammaRow.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(gammaRow).not.toContainText('/custom-apps-latest/gamma-reporter');
    await alphaRow.locator('input').fill('legacy-tool');
    await expect(alphaRow).toContainText('URL slug is already used by Legacy Tool.');
    await expect(alphaRow.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await alphaRow.locator('input').fill('alpha-helper');
    await betaRow.locator('input').fill('beta-console');
    await alphaRow.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect.poll(() => routeTrackers.webAppPublishRequests.length).toBe(2);
    expect(routeTrackers.webAppPublishRequests[1]).toEqual({
      relativePath: project.relativePath,
      publications: [
        { uiGraphId: 'ui-graph-alpha', slug: 'alpha-helper', allowedEmails: [] },
      ],
    });
    await betaRow.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(webAppSection.locator('.project-settings-web-app-state')).toHaveCount(4);
    await expect(alphaRow).toContainText('Published');
    await expect(betaRow).toContainText('Published');
    await expect(deleteButton).toBeDisabled();
    await expect(alphaRow.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(alphaRow).toContainText('The web app is accessible via the endpoint on');
    await expect(alphaRow).toContainText('/custom-apps/alpha-helper');
    await expect(alphaRow).not.toContainText('/custom-apps-latest/alpha-helper');
    const currentOrigin = await page.evaluate(() => window.location.origin);
    const publishedAppLink = alphaRow.getByRole('link', { name: 'Open /custom-apps/alpha-helper in a new tab' });
    await expect(publishedAppLink).toHaveAttribute('href', `${currentOrigin}/custom-apps/alpha-helper`);
    await expect(publishedAppLink).toHaveAttribute('target', '_blank');
    await expect(alphaRow.getByRole('link', { name: 'Open /custom-apps-latest/alpha-helper in a new tab' })).toHaveCount(0);
    await expect(alphaRow.getByRole('button', { name: 'Unpublish' })).toHaveCSS('margin-left', '8px');
    await alphaRow.locator('input').fill('alpha-helper-renamed');
    await expect(alphaRow.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(alphaRow).toContainText('/custom-apps/alpha-helper');
    await expect(alphaRow).not.toContainText('/custom-apps/alpha-helper-renamed');
    await expect.poll(() => routeTrackers.webAppPublishRequests.length).toBe(3);
    expect(routeTrackers.webAppPublishRequests[2]).toEqual({
      relativePath: project.relativePath,
      publications: [
        { uiGraphId: 'ui-graph-beta', slug: 'beta-console', allowedEmails: [] },
      ],
    });
    await expect(staleRow.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(staleRow.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    await alphaRow.getByRole('button', { name: 'Unpublish' }).click();
    await expect.poll(() => routeTrackers.webAppUnpublishRequests.length).toBe(1);
    expect(routeTrackers.webAppUnpublishRequests).toEqual([{
      relativePath: project.relativePath,
      uiGraphId: 'ui-graph-alpha',
    }]);
    await expect(alphaRow.locator('.project-settings-web-app-state')).toHaveText('Not published');
    await expect(betaRow.locator('.project-settings-web-app-state')).toHaveText('Published');
    await expect(deleteButton).toBeDisabled();

    page.once('dialog', (dialog) => dialog.accept());
    await staleRow.getByRole('button', { name: 'Unpublish' }).click();
    await expect.poll(() => routeTrackers.webAppUnpublishRequests.length).toBe(2);
    expect(routeTrackers.webAppUnpublishRequests[1]).toEqual({
      relativePath: project.relativePath,
      uiGraphId: 'ui-graph-stale',
    });
    await expect(staleRow).toHaveCount(0);
  });

  test('web app settings explains when available web apps are not published yet', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-project-settings-unpublished-web-apps');
    project.webApps = [
      {
        uiGraphId: 'ui-graph-draft',
        name: 'Draft Helper',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const webAppSection = modal.locator('.project-settings-web-app-section');
    await expect(webAppSection).toContainText('No web apps are published.');
    await expect(webAppSection.locator('.project-settings-web-app-row')).toHaveCount(1);
    await expect(webAppSection).toContainText('Draft Helper');
  });

  test('published version history paginates, stars, previews, and restores versions', async ({ page }) => {
    test.slow();

    const unique = 'codex-project-settings-history';
    const endpointName = 'codex-project-settings-history-endpoint';
    const project = createProjectSettingsFixture(unique);
    project.settings = {
      status: 'published',
      endpointName,
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: project.settings.publishedWebApps,
    };
    const routeTrackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, routeTrackers);

    const { modal, projectRow } = await openProjectSettingsModal(page, project);

    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await modal.getByRole('button', { name: 'Published version history' }).click();
    const historyModal = page.getByTestId('workflow-published-version-history-modal');
    await expect(historyModal).toBeVisible();
    await expect(historyModal).toContainText('Published version history');
    await expect(historyModal).toContainText(endpointName);
    await expect(historyModal).toContainText('Current');
    await expect(historyModal.getByRole('listitem')).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Preview' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Restore' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Star published version' })).toHaveCount(10);
    const addFirstCommentButton = historyModal.getByRole('button', {
      name: 'Add comment for published version published-version-1',
      exact: true,
    });
    await expect(addFirstCommentButton).toBeVisible();
    await expect(historyModal.getByRole('textbox', {
      name: 'Comment for published version published-version-1',
      exact: true,
    })).toHaveCount(0);
    await historyModal.getByRole('button', { name: 'Star published version' }).first().click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    expect(routeTrackers.publishedVersionStarRequests).toEqual([{
      relativePath: project.relativePath,
      versionId: 'published-version-1',
      isStarred: true,
    }]);
    await addFirstCommentButton.click();
    const firstCommentInput = historyModal.getByRole('textbox', {
      name: 'Comment for published version published-version-1',
      exact: true,
    });
    await expect(firstCommentInput).toBeFocused();
    await firstCommentInput.fill('Launch baseline');
    await firstCommentInput.press('Enter');
    await expect.poll(() => routeTrackers.publishedVersionCommentRequests.length).toBe(1);
    expect(routeTrackers.publishedVersionCommentRequests).toEqual([{
      relativePath: project.relativePath,
      versionId: 'published-version-1',
      comment: 'Launch baseline',
    }]);
    await expect(firstCommentInput).toHaveCount(0);
    const savedComment = historyModal.getByRole('button', {
      name: 'Edit comment for published version published-version-1',
      exact: true,
    });
    await expect(savedComment).toHaveText('Launch baseline');
    await savedComment.click();
    await expect(firstCommentInput).toHaveValue('Launch baseline');
    await firstCommentInput.fill('Do not save');
    await firstCommentInput.press('Escape');
    await expect(firstCommentInput).toHaveCount(0);
    await expect(savedComment).toHaveText('Launch baseline');
    await expect.poll(() => routeTrackers.publishedVersionCommentRequests.length).toBe(1);
    await historyModal.getByRole('button', { name: 'Close published version history' }).click({ force: true });
    await expect(historyModal).toHaveCount(0);
    await modal.getByRole('button', { name: 'Published version history' }).click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    await expect(historyModal.getByRole('button', {
      name: 'Edit comment for published version published-version-1',
      exact: true,
    })).toHaveText('Launch baseline');
    await expect(historyModal.getByText('Page 1 of 2')).toBeVisible();
    await expect(historyModal.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await historyModal.getByRole('button', { name: 'Next' }).click();
    await expect(historyModal.getByRole('listitem')).toHaveCount(2);
    await expect(historyModal.getByText('Page 2 of 2')).toBeVisible();
    await expect(historyModal).toContainText(`${endpointName}-11`);
    await expect(historyModal.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
    await historyModal.getByRole('button', { name: 'Previous' }).click();
    await historyModal.getByRole('button', { name: 'Preview' }).first().click();
    await expect(historyModal).toHaveCount(0);
    await expect.poll(() => routeTrackers.publishedVersionPreviewRequests.length).toBe(1);
    expect(routeTrackers.publishedVersionPreviewRequests[0]).toEqual({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(page.locator('.dashboard-empty-state')).toBeHidden();
    await expect(page.locator('.Toastify__toast', { hasText: 'Failed to open project' })).toHaveCount(0);
    await expect(modal).toHaveCount(0);

    await projectRow.click();
    await projectRow.dblclick();
    await expect.poll(() => routeTrackers.projectLoadRequests.length).toBe(1);
    expect(routeTrackers.projectLoadRequests[0]).toEqual({
      path: project.absolutePath,
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });

    await modal.getByRole('button', { name: 'Published version history' }).click();
    await expect(historyModal).toBeVisible();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Restore this published version');
      await dialog.accept();
    });
    await historyModal.getByRole('button', { name: 'Restore' }).first().click();
    await expect.poll(() => routeTrackers.publishedVersionRestoreRequests.length).toBe(1);
    expect(routeTrackers.publishedVersionRestoreRequests[0]).toEqual({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(historyModal.getByRole('listitem').first()).toContainText(endpointName);
    await expect(historyModal.getByRole('listitem').first()).toContainText('Current');
    await expect(historyModal.getByText('Page 1 of 2')).toBeVisible();
    await expect.poll(() => routeTrackers.projectLoadRequests.length).toBe(2);
    expect(routeTrackers.projectLoadRequests[1]).toEqual({
      path: project.absolutePath,
    });
    await historyModal.getByRole('button', { name: 'Close published version history' }).click();
    await expect(historyModal).toHaveCount(0);
  });
});
