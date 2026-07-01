import { expect, test, type Page } from '@playwright/test';
import type {
  WorkflowProjectItem,
  WorkflowProjectStatus,
  WorkflowProjectWebAppSummary,
} from '../../shared/workflow-types';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';

const STATUS_DOT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgb(187, 187, 187)',
  published: 'rgb(126, 226, 148)',
  unpublished_changes: 'rgb(255, 215, 106)',
};

const ACTIVE_PROJECT_BACKGROUND: Record<WorkflowProjectStatus, string> = {
  unpublished: 'rgba(255, 255, 255, 0.07)',
  published: 'rgba(126, 226, 148, 0.12)',
  unpublished_changes: 'rgba(255, 215, 106, 0.12)',
};

function createStatusProject(status: WorkflowProjectStatus): WorkflowProjectItem {
  const name = `codex-collapsed-dot-${status}`;

  return {
    id: name,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/managed/workflows/${name}.rivet-project`,
    updatedAt: '2026-05-15T10:00:00.000Z',
    settings: {
      status,
      endpointName: `${name}-endpoint`,
      lastPublishedAt: status === 'unpublished' ? null : '2026-05-15T09:00:00.000Z',
      publishedWebApps: [],
    },
  };
}

async function installStatusDotTreeRoute(page: Page, projects: WorkflowProjectItem[]): Promise<void> {
  await page.route('**/api/workflows/tree', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        root: '/managed/workflows',
        folders: [],
        projects,
      }),
    });
  });
}

async function installProjectWebAppsRoute(
  page: Page,
  webAppsByRelativePath: Record<string, WorkflowProjectWebAppSummary[]>,
): Promise<void> {
  await page.route('**/api/workflows/projects/web-apps**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/workflows/projects/web-apps') {
      await route.fallback();
      return;
    }

    const relativePath = url.searchParams.get('relativePath') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        webApps: webAppsByRelativePath[relativePath] ?? [],
      }),
    });
  });
}

async function installAppSettingsRoute(page: Page): Promise<void> {
  let publicRouteSettings = {
    publishedWorkflowsBasePath: '/workflows',
    latestWorkflowsBasePath: '/workflows-latest',
    publishedAppsBasePath: '/apps',
    latestAppsBasePath: '/apps-latest',
    updatedAt: null as string | null,
    source: 'default',
  };
  let deploymentStorageSettings = {
    storageMode: 'filesystem',
    artifactsHostPath: '../',
    databaseMode: 'local-docker',
    databaseSslMode: 'disable',
    databaseConnectionStringConfigured: false,
    storageUrl: '',
    storageAccessKeyId: '',
    storageAccessKeyConfigured: false,
    updatedAt: null as string | null,
    source: 'default',
  };

  await page.route('**/api/config', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.pathname !== '/api/config') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...publicRouteSettings,
        webAppsAuthMode: 'ui-gate',
        storageMode: deploymentStorageSettings.storageMode,
        databaseMode: deploymentStorageSettings.databaseMode,
      }),
    });
  });

  await page.route('**/api/app-settings/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (url.pathname === '/api/app-settings/node-executor-proxy') {
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as {
          httpProxy?: string;
          httpsProxy?: string;
          noProxy?: string;
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            httpProxy: body.httpProxy ?? '',
            httpsProxy: body.httpsProxy ?? '',
            noProxy: body.noProxy ?? '',
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          httpProxy: 'http://172.17.0.1:3128',
          httpsProxy: 'http://172.17.0.1:3128',
          noProxy: 'localhost,127.0.0.1,::1,api,web,executor,proxy,172.17.0.1',
          updatedAt: '2026-06-30T12:00:00.000Z',
          source: 'app-settings',
        }),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/run-recordings') {
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as {
          maxPendingWrites?: string | number;
          maxRunsPerEndpoint?: string | number;
          retentionDays?: string | number;
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            maxPendingWrites: Number(body.maxPendingWrites ?? 100),
            maxRunsPerEndpoint: Number(body.maxRunsPerEndpoint ?? 2000),
            retentionDays: Number(body.retentionDays ?? 0),
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maxPendingWrites: 100,
          maxRunsPerEndpoint: 2000,
          retentionDays: 0,
          updatedAt: '2026-06-30T12:00:00.000Z',
          source: 'app-settings',
        }),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/public-routes') {
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as {
          publishedWorkflowsBasePath?: string;
          latestWorkflowsBasePath?: string;
          publishedAppsBasePath?: string;
          latestAppsBasePath?: string;
        };
        const normalizeSlug = (value: unknown, fallback: string) => {
          const normalized = String(value || fallback).trim().replace(/^\/+/, '').replace(/\/+$/, '');
          return `/${normalized}`;
        };
        publicRouteSettings = {
          publishedWorkflowsBasePath: normalizeSlug(body.publishedWorkflowsBasePath, 'workflows'),
          latestWorkflowsBasePath: normalizeSlug(body.latestWorkflowsBasePath, 'workflows-latest'),
          publishedAppsBasePath: normalizeSlug(body.publishedAppsBasePath, 'apps'),
          latestAppsBasePath: normalizeSlug(body.latestAppsBasePath, 'apps-latest'),
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(publicRouteSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(publicRouteSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/deployment-storage') {
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        deploymentStorageSettings = {
          storageMode: String(body.storageMode ?? deploymentStorageSettings.storageMode),
          artifactsHostPath: String(body.artifactsHostPath ?? deploymentStorageSettings.artifactsHostPath),
          databaseMode: String(body.databaseMode ?? deploymentStorageSettings.databaseMode),
          databaseSslMode: String(body.databaseSslMode ?? deploymentStorageSettings.databaseSslMode),
          databaseConnectionStringConfigured: Boolean(body.databaseConnectionString) || deploymentStorageSettings.databaseConnectionStringConfigured,
          storageUrl: String(body.storageUrl ?? deploymentStorageSettings.storageUrl),
          storageAccessKeyId: String(body.storageAccessKeyId ?? deploymentStorageSettings.storageAccessKeyId),
          storageAccessKeyConfigured: Boolean(body.storageAccessKey) || deploymentStorageSettings.storageAccessKeyConfigured,
          updatedAt: '2026-06-30T12:01:00.000Z',
          source: 'app-settings',
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(deploymentStorageSettings),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(deploymentStorageSettings),
      });
      return;
    }

    if (url.pathname === '/api/app-settings/web-app-auth') {
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            mode: body.mode ?? 'ui-gate',
            provider: body.provider ?? 'external',
            dummyEmail: body.dummyEmail ?? 'local@example.test',
            dummyAllowNonLocalhost: body.dummyAllowNonLocalhost ?? false,
            authorizeUrl: body.authorizeUrl ?? '',
            tokenUrl: body.tokenUrl ?? '',
            userUrl: body.userUrl ?? '',
            clientId: body.clientId ?? '',
            clientSecretConfigured: Boolean(body.clientSecret) || false,
            callbackUrl: body.callbackUrl ?? '',
            scopes: body.scopes ?? 'email',
            emailClaim: body.emailClaim ?? 'email',
            sessionSecretConfigured: Boolean(body.sessionSecret) || false,
            sessionTtlSeconds: Number(body.sessionTtlSeconds ?? 86400),
            clientAuthMethod: body.clientAuthMethod ?? 'body',
            debugLogProfile: body.debugLogProfile ?? false,
            updatedAt: '2026-06-30T12:01:00.000Z',
            source: 'app-settings',
          }),
        });
        return;
      }

      if (method !== 'GET') {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mode: 'ui-gate',
          provider: 'external',
          dummyEmail: 'local@example.test',
          dummyAllowNonLocalhost: false,
          authorizeUrl: '',
          tokenUrl: '',
          userUrl: '',
          clientId: '',
          clientSecretConfigured: false,
          callbackUrl: '',
          scopes: 'email',
          emailClaim: 'email',
          sessionSecretConfigured: false,
          sessionTtlSeconds: 86400,
          clientAuthMethod: 'body',
          debugLogProfile: false,
          updatedAt: null,
          source: 'default',
        }),
      });
      return;
    }

    await route.fallback();
  });
}

async function dispatchProjectOpenedFromEditorFrame(page: Page, path: string): Promise<void> {
  await page.evaluate((projectPath) => {
    const editorFrame = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame');

    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'project-opened', path: projectPath },
      origin: window.location.origin,
      source: editorFrame?.contentWindow ?? null,
    }));
  }, path);
}

test.describe('Workflow library layout', () => {
  test('collapses from the full header row into a clickable narrow rail', async ({ page }) => {
    await installAppSettingsRoute(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(Math.round(headerBox!.height)).toBe(37);
    await expect(header).toHaveCSS('border-bottom-width', '0px');

    const collapseButton = page.getByRole('button', { name: 'Collapse folders pane' });
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(collapseButton).toBeVisible();
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseButton.locator('path').last()).toHaveAttribute('d', 'M5.25 4.75v6.5');

    const collapseButtonBox = await collapseButton.boundingBox();
    const titleBox = await title.boundingBox();
    expect(collapseButtonBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(collapseButtonBox!.x).toBeLessThan(titleBox!.x);

    const bottomActions = page.locator('.workflow-library-panel .panel-bottom-actions');
    await expect(bottomActions).toHaveCSS('padding-bottom', '24px');

    await expect(page.getByRole('button', { name: 'App settings' })).toBeVisible();
    await page.getByRole('button', { name: 'App settings' }).click();
    const appSettingsModal = page.locator('[data-testid="app-settings-modal"]');
    await expect(appSettingsModal).toBeVisible();
    await expect(appSettingsModal.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal).toContainText('Rivet Studio Server');
    await expect(appSettingsModal).toContainText('Published workflows');
    await expect(appSettingsModal).toContainText('/workflows');
    await expect(appSettingsModal).toContainText('Published web apps');
    await expect(appSettingsModal).toContainText('/apps');

    await appSettingsModal.getByRole('tab', { name: 'Workflow endpoints' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Workflow endpoints' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-section-title')).toContainText(['Routes']);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('workflows');
    await expect(appSettingsModal.getByLabel('Latest saved workflow endpoint URL slug')).toHaveValue('workflows-latest');
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveCount(0);
    await appSettingsModal.getByLabel('Published workflow endpoint URL slug').fill('public-workflows');
    await appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-actions-row').getByRole('button', { name: 'Save' }).click();
    const workflowRouteActions = appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-actions-row');
    await expect(workflowRouteActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveValue('public-workflows');
    await expect.poll(async () => {
      const [contentBox, sectionBox] = await Promise.all([
        appSettingsModal.locator('.app-settings-modal-content').boundingBox(),
        appSettingsModal.locator('.app-settings-workflow-endpoints-panel .app-settings-section').boundingBox(),
      ]);
      return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
    }).toBeGreaterThan(0.9);

    await appSettingsModal.getByRole('tab', { name: 'Storage' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Storage' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section')).toHaveCount(2);
    await expect(appSettingsModal.getByRole('button', { name: 'Local folders' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Object storage' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByLabel('Host artifacts folder')).toHaveValue('../');
    const storageFieldGrids = appSettingsModal.locator('.app-settings-storage-panel .app-settings-field-grid');
    await expect(storageFieldGrids.first()).toHaveCSS('gap', '18px');
    await expect(storageFieldGrids.nth(1)).toHaveCSS('gap', '18px');
    await appSettingsModal.getByLabel('Host artifacts folder').fill('../storage-artifacts');
    await appSettingsModal.getByRole('button', { name: 'Object storage' }).click();
    await expect(appSettingsModal.getByRole('button', { name: 'Local Docker Postgres' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByText('It must already be running before object storage mode can apply.')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Object storage URL')).toHaveValue('');
    await expect(appSettingsModal.getByLabel('Object storage access key ID')).toHaveValue('');
    await appSettingsModal.getByLabel('Object storage URL').fill('http://workflow-minio:9000/rivet-workflows');
    await appSettingsModal.getByLabel('Object storage access key ID').fill('minioadmin');
    await appSettingsModal.getByLabel('Object storage secret access key').fill('minioadmin');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-actions-row')).toHaveCSS('border-top-width', '1px');
    await appSettingsModal.locator('.app-settings-storage-panel .app-settings-actions-row').getByRole('button', { name: 'Save' }).click();
    const storageActions = appSettingsModal.locator('.app-settings-storage-panel .app-settings-actions-row');
    await expect(storageActions.locator('.project-settings-success')).toHaveText('Saved. Restart or recreate the stack to apply storage changes.');
    await expect(appSettingsModal.locator('.app-settings-storage-panel .app-settings-section > .project-settings-success')).toHaveCount(0);

    await appSettingsModal.getByRole('tab', { name: 'Run recordings' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Run recordings' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Queued recording writes')).toHaveValue('100');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep latest runs' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep all runs' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep forever' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByRole('button', { name: 'Keep for some time' })).toHaveAttribute('aria-pressed', 'false');
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-field-grid')).toHaveCSS('gap', '18px');
    await expect(appSettingsModal.getByText('Keeping only the newest runs for each endpoint. Older runs are removed during cleanup.')).toBeVisible();
    await expect(appSettingsModal.getByText('Recordings are kept indefinitely unless another saved limit removes them.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep all runs' }).click();
    await expect(appSettingsModal.getByText('Keeping every recorded run for each endpoint.')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveCount(0);
    await appSettingsModal.getByRole('button', { name: 'Keep latest runs' }).click();
    await expect(appSettingsModal.getByLabel('Newest runs to keep per workflow endpoint')).toHaveValue('2000');
    await appSettingsModal.getByRole('button', { name: 'Keep for some time' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveValue('14');
    await expect(appSettingsModal.getByText('Recordings older than the selected number of days are removed during cleanup.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'Keep forever' }).click();
    await expect(appSettingsModal.getByRole('spinbutton', { name: 'Days to keep recordings' })).toHaveCount(0);
    await expect.poll(async () => {
      const [contentBox, sectionBox] = await Promise.all([
        appSettingsModal.locator('.app-settings-modal-content').boundingBox(),
        appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section').boundingBox(),
      ]);
      return contentBox && sectionBox ? sectionBox.width / contentBox.width : 0;
    }).toBeGreaterThan(0.9);
    await appSettingsModal.getByLabel('Queued recording writes').fill('101');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-actions-row')).toHaveCSS('border-top-width', '1px');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-actions-row')).toHaveCSS('margin-top', '8px');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-actions-row')).toHaveCSS('padding-top', '14px');
    await appSettingsModal.getByRole('button', { name: 'Save' }).click();
    const recordingsActions = appSettingsModal.locator('.app-settings-recordings-panel .app-settings-actions-row');
    await expect(recordingsActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.locator('.app-settings-recordings-panel .app-settings-section > .project-settings-success')).toHaveCount(0);
    await appSettingsModal.getByRole('tab', { name: 'Node executor proxy' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Node executor proxy' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-section-title')).toHaveCount(0);
    await expect(appSettingsModal.getByText('HTTP_PROXY')).toBeVisible();
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-field-grid')).toHaveCSS('gap', '18px');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-action-button').first()).toHaveCSS('height', '40px');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-action-button').first()).toHaveCSS('min-width', '84px');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-actions-row')).toHaveCSS('border-top-width', '1px');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-actions-row')).toHaveCSS('margin-top', '8px');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-actions-row')).toHaveCSS('padding-top', '14px');
    await expect(appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' })).toHaveValue('http://172.17.0.1:3128');
    await expect(appSettingsModal.getByText('NO_PROXY')).toBeVisible();
    await expect(appSettingsModal.getByRole('textbox', { name: 'NO_PROXY' })).toHaveValue('localhost,127.0.0.1,::1,api,web,executor,proxy,172.17.0.1');
    await appSettingsModal.getByRole('textbox', { name: 'HTTP_PROXY' }).fill('http://172.17.0.1:3129');
    await appSettingsModal.getByRole('button', { name: 'Save' }).click();
    const proxyActions = appSettingsModal.locator('.app-settings-proxy-panel .app-settings-actions-row');
    await expect(proxyActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.locator('.app-settings-proxy-panel .app-settings-section > .project-settings-success')).toHaveCount(0);

    await appSettingsModal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(appSettingsModal.getByRole('tab', { name: 'Web apps' })).toHaveAttribute('aria-selected', 'true');
    await expect(appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-section-title')).toContainText(['Routes', 'Auth']);
    await expect(appSettingsModal.getByLabel('Published workflow endpoint URL slug')).toHaveCount(0);
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveValue('apps');
    await expect(appSettingsModal.getByLabel('Latest saved changes URL slug')).toHaveValue('apps-latest');
    const appRouteRow = appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-prefixed-input-row').first();
    await expect(appRouteRow).toHaveCSS('display', 'flex');
    await expect.poll(async () => {
      const [prefixBox, inputBox] = await Promise.all([
        appRouteRow.locator('.project-settings-url-prefix').boundingBox(),
        appRouteRow.locator('.project-settings-input').boundingBox(),
      ]);
      return prefixBox && inputBox
        ? Math.max(Math.abs(prefixBox.y - inputBox.y), Math.abs(prefixBox.height - inputBox.height))
        : Number.POSITIVE_INFINITY;
    }).toBeLessThanOrEqual(1);
    await appSettingsModal.getByLabel('Published web app URL slug').fill('public-apps');
    await appSettingsModal.getByRole('button', { name: 'Save' }).first().click();
    const webRouteActions = appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-actions-row').first();
    await expect(webRouteActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByLabel('Published web app URL slug')).toHaveValue('public-apps');
    await expect(appSettingsModal.getByText(/restart/i)).toHaveCount(0);
    await expect(appSettingsModal.getByRole('button', { name: 'Rivet key' })).toHaveAttribute('aria-pressed', 'true');
    await expect(appSettingsModal.getByText('Visitors use the same Rivet key prompt as the server UI.')).toBeVisible();
    await appSettingsModal.getByRole('button', { name: 'OAuth' }).click();
    await expect(appSettingsModal.getByText("Visitors sign in with OAuth and are checked against each web app's allowed-email list.")).toBeVisible();
    await expect(appSettingsModal.getByRole('button', { name: 'External provider' })).toHaveAttribute('aria-pressed', 'true');
    await appSettingsModal.getByRole('button', { name: 'Local dummy' }).click();
    await expect(appSettingsModal.getByText('Default test email')).toBeVisible();
    await expect(appSettingsModal.getByLabel('Default test email')).toHaveValue('local@example.test');
    await appSettingsModal.getByLabel('Session signing secret').fill('local-session-secret');
    await appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-actions-row').last().getByRole('button', { name: 'Save' }).click();
    const webAuthActions = appSettingsModal.locator('.app-settings-web-apps-panel .app-settings-actions-row').last();
    await expect(webAuthActions.locator('.project-settings-success')).toHaveText('Saved.');
    await expect(appSettingsModal.getByRole('tab', { name: 'General' })).toBeVisible();
    await appSettingsModal.getByRole('tab', { name: 'General' }).click();
    await expect(appSettingsModal).toContainText('OAuth');
    await page.getByRole('button', { name: 'Close app settings' }).click();
    await expect(appSettingsModal).toHaveCount(0);

    await page.getByRole('button', { name: 'About' }).click();
    const aboutModal = page.locator('[data-testid="about-modal"]');
    await expect(aboutModal).toBeVisible();
    await expect(aboutModal).toContainText('Rivet Studio Server');
    await expect(aboutModal).toContainText('Version');
    await expect(aboutModal).toContainText(/Version\s*\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    await page.getByRole('button', { name: 'Close about' }).click();
    await expect(aboutModal).toHaveCount(0);

    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const expandButton = page.getByRole('button', { name: 'Expand folders pane' });
    await expect(expandButton).toBeVisible();
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false');
    await expect(expandButton.locator('path')).toHaveAttribute('d', 'M6 4.5 9.5 8 6 11.5');
    await expect(header).toHaveCount(1);
    await expect(title).toHaveCount(1);
    await expect(header).toBeHidden();
    await expect(title).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show main panel' })).toHaveCount(0);

    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    const sidebarBox = await sidebar.boundingBox();
    const expandButtonBox = await expandButton.boundingBox();
    const expandIconBox = await expandButton.locator('svg').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(expandButtonBox).not.toBeNull();
    expect(expandIconBox).not.toBeNull();
    expect(Math.round(expandButtonBox!.width)).toBe(Math.round(sidebarBox!.width));
    expect(Math.round(expandButtonBox!.height)).toBe(Math.round(sidebarBox!.height));
    expect(Math.abs((expandIconBox!.y + expandIconBox!.height / 2) - (sidebarBox!.y + sidebarBox!.height / 2))).toBeLessThan(2);

    await page.mouse.click(sidebarBox!.x + sidebarBox!.width / 2, sidebarBox!.y + sidebarBox!.height - 20);

    const titleVisibilityDuringExpand = await title.evaluate((element) => window.getComputedStyle(element).visibility);
    expect(titleVisibilityDuringExpand).toBe('hidden');
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBeGreaterThan(200);
    await expect(page.getByRole('button', { name: 'Collapse folders pane' })).toBeVisible();
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Rivet Projects');
  });

  test('resizes with a wider drag target and folds while dragging below half the minimum width', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const sidebar = page.locator('.dashboard-sidebar');
    const resizer = page.locator('.dashboard-sidebar-resizer');
    const title = page.locator('.workflow-library-panel .header-title');
    await expect(resizer).toBeVisible();

    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    expect(Math.round(resizerBox!.width)).toBeGreaterThanOrEqual(14);

    const dragY = resizerBox!.y + 48;
    await page.mouse.move(resizerBox!.x + resizerBox!.width / 2, dragY);
    await page.mouse.down();

    await page.mouse.move(90, dragY, { steps: 4 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);
    await expect(title).toBeHidden();

    await page.mouse.move(280, dragY, { steps: 6 });
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
    await page.mouse.up();

    await expect(title).toBeVisible();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(280);
  });

  test('shows the opened project status as a collapsed rail dot', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    await expect(page.getByRole('button', { name: projects[0].name, exact: true })).toBeEnabled({ timeout: 180_000 });

    const sidebar = page.locator('.dashboard-sidebar');
    const header = page.locator('.workflow-library-panel .header');
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    await dispatchProjectOpenedFromEditorFrame(page, projects[0].absolutePath);
    await header.click({ position: { x: headerBox!.width - 8, y: headerBox!.height / 2 } });

    const statusDot = page.locator('.workflow-library-panel .collapsed-strip-status-dot');
    await expect(statusDot).toBeHidden();
    await expect.poll(async () => Math.round((await sidebar.boundingBox())?.width ?? 0)).toBe(30);

    for (const project of projects.slice(1)) {
      await dispatchProjectOpenedFromEditorFrame(page, project.absolutePath);
      await expect(statusDot).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(statusDot).toHaveCSS('background-color', STATUS_DOT_BACKGROUND[project.settings.status]);
    }

    const sidebarBox = await sidebar.boundingBox();
    const statusDotBox = await statusDot.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(statusDotBox).not.toBeNull();
    expect(Math.round(statusDotBox!.width)).toBe(12);
    expect(Math.round(statusDotBox!.height)).toBe(12);
    expect(Math.abs((statusDotBox!.x + statusDotBox!.width / 2) - (sidebarBox!.x + sidebarBox!.width / 2))).toBeLessThan(2);
    expect(Math.abs((statusDotBox!.y + statusDotBox!.height / 2) - (sidebarBox!.y + 18.5))).toBeLessThan(2);
  });

  test('tints the active project summary by publication status', async ({ page }) => {
    const projects = (['unpublished', 'published', 'unpublished_changes'] as const).map(createStatusProject);
    await installStatusDotTreeRoute(page, projects);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');

    for (const project of projects) {
      await page.getByRole('button', { name: project.name, exact: true }).click();
      await expect(activeProjectSection).toHaveClass(new RegExp(`\\b${project.settings.status}\\b`));
      await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND[project.settings.status]);
    }
  });

  test('shows workflow and web app publication status lines in the active project summary', async ({ page }) => {
    const noAppsProject = createStatusProject('unpublished');
    noAppsProject.name = 'codex-summary-no-apps';
    noAppsProject.fileName = 'codex-summary-no-apps.rivet-project';
    noAppsProject.relativePath = 'codex-summary-no-apps.rivet-project';
    noAppsProject.absolutePath = '/managed/workflows/codex-summary-no-apps.rivet-project';
    noAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 0 };

    const oneAppProject = createStatusProject('unpublished');
    oneAppProject.name = 'codex-summary-one-app';
    oneAppProject.fileName = 'codex-summary-one-app.rivet-project';
    oneAppProject.relativePath = 'codex-summary-one-app.rivet-project';
    oneAppProject.absolutePath = '/managed/workflows/codex-summary-one-app.rivet-project';
    oneAppProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 1 };
    oneAppProject.settings.publicationStatus = 'published';

    const sameStatusAppsProject = createStatusProject('published');
    sameStatusAppsProject.name = 'codex-summary-same-apps';
    sameStatusAppsProject.fileName = 'codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.relativePath = 'codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.absolutePath = '/managed/workflows/codex-summary-same-apps.rivet-project';
    sameStatusAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 2 };
    sameStatusAppsProject.settings.publicationStatus = 'unpublished_changes';

    const mixedStatusAppsProject = createStatusProject('unpublished_changes');
    mixedStatusAppsProject.name = 'codex-summary-mixed-apps';
    mixedStatusAppsProject.fileName = 'codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.relativePath = 'codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.absolutePath = '/managed/workflows/codex-summary-mixed-apps.rivet-project';
    mixedStatusAppsProject.stats = { graphCount: 1, totalNodeCount: 2, webAppCount: 2 };

    await installStatusDotTreeRoute(page, [
      noAppsProject,
      oneAppProject,
      sameStatusAppsProject,
      mixedStatusAppsProject,
    ]);
    await installProjectWebAppsRoute(page, {
      [oneAppProject.relativePath]: [
        {
          uiGraphId: 'one-app',
          name: 'One App',
          publishedSlug: 'one-app',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'published',
          isMissingFromProject: false,
        },
      ],
      [sameStatusAppsProject.relativePath]: [
        {
          uiGraphId: 'same-app-a',
          name: 'Same App A',
          publishedSlug: 'same-app-a',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'same-app-b',
          name: 'Same App B',
          publishedSlug: 'same-app-b',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'unpublished_changes',
          isMissingFromProject: false,
        },
      ],
      [mixedStatusAppsProject.relativePath]: [
        {
          uiGraphId: 'mixed-app-a',
          name: 'Mixed App A',
          publishedSlug: 'mixed-app-a',
          publishedAt: '2026-05-15T09:00:00.000Z',
          status: 'published',
          isMissingFromProject: false,
        },
        {
          uiGraphId: 'mixed-app-b',
          name: 'Mixed App B',
          publishedSlug: null,
          publishedAt: null,
          status: 'unpublished',
          isMissingFromProject: false,
        },
      ],
    });

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);

    const activeProjectSlot = page.locator('.workflow-library-panel .active-project-slot');
    const activeProjectSection = page.locator('.workflow-library-panel .active-project-section');
    const statusLines = activeProjectSection.locator('.active-project-status-line');

    await expect(activeProjectSlot).toHaveCSS('height', '166px');
    await expect(activeProjectSection).toHaveCSS('height', '166px');
    await expect(page.getByRole('button', { name: noAppsProject.name, exact: true }).locator('.project-status-dot')).toBeHidden();
    await expect(page.getByRole('button', { name: oneAppProject.name, exact: true }).locator('.project-status-dot')).toHaveClass(/\bpublished\b/);
    await expect(page.getByRole('button', { name: sameStatusAppsProject.name, exact: true }).locator('.project-status-dot')).toHaveClass(/\bunpublished_changes\b/);

    await page.getByRole('button', { name: noAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-details > :first-child')).toHaveClass(/active-project-name-row/);
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(noAppsProject.name);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first()).toContainText('Endpoint:');
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Unpublished');
    await expect(statusLines.nth(1)).toContainText('Web app:');
    await expect(statusLines.nth(1).locator('.active-project-status-text')).toHaveText('none');
    await expect(statusLines.first()).toHaveCSS('height', '22px');
    await expect(statusLines.nth(1)).toHaveCSS('height', '22px');
    await expect(statusLines.nth(1).locator('.active-project-status-text')).toHaveCSS('height', '22px');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes');
    await expect(activeProjectSection.locator('.active-project-actions-row')).toHaveCSS('margin-top', '8px');

    await page.getByRole('button', { name: oneAppProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(oneAppProject.name);
    await expect(activeProjectSection).toHaveClass(/\bpublished\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.published);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Unpublished');
    await expect(statusLines.nth(1)).toContainText('Web app:');
    await expect(statusLines.nth(1).locator('.project-status-badge')).toHaveText('Published');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 1 web app');

    await page.getByRole('button', { name: sameStatusAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(sameStatusAppsProject.name);
    await expect(activeProjectSection).toHaveClass(/\bunpublished_changes\b/);
    await expect(activeProjectSection).toHaveCSS('background-color', ACTIVE_PROJECT_BACKGROUND.unpublished_changes);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.first().locator('.project-status-badge')).toHaveText('Published');
    await expect(statusLines.nth(1)).toContainText('Web apps:');
    await expect(statusLines.nth(1).locator('.project-status-badge')).toHaveText('Unpublished changes');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 2 web apps');

    await page.getByRole('button', { name: mixedStatusAppsProject.name, exact: true }).click();
    await expect(activeProjectSection.locator('.active-project-name')).toHaveText(mixedStatusAppsProject.name);
    await expect(statusLines).toHaveCount(2);
    await expect(statusLines.nth(1)).toContainText('Web apps:');
    await expect(statusLines.nth(1).locator('.active-project-various-statuses')).toHaveText('various statuses');
    await expect(activeProjectSection.locator('.active-project-stats')).toHaveText('1 graph, 2 nodes, 2 web apps');
    await expect(activeProjectSlot).toHaveCSS('height', '166px');
    await expect(activeProjectSection).toHaveCSS('height', '166px');
  });
});
