import { expect, type Request } from '@playwright/test';
import { test } from './helpers/projectPublicationFixture';
import { authenticateIfNeeded, openProjectContextMenu, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  createProjectSettingsFixture,
  createProjectSettingsRouteTrackers,
  createProjectWebAppsResponse,
  installProjectSettingsRoutes,
  isRouteRequest,
  openProjectSettingsModal,
  showProjectSettingsModal,
} from './helpers/projectSettingsObserve';

test.describe('Project settings modal', () => {
  for (const publication of ['unpublished', 'published', 'unpublished_changes', 'web-app-only'] as const) {
    test(`Delete project opens the appropriate settings tab for ${publication}`, async ({ page }) => {
      const project = createProjectSettingsFixture(`delete-entry-${publication}`);
      const fullyUnpublished = publication === 'unpublished';
      if (publication === 'published' || publication === 'unpublished_changes') {
        project.settings.status = publication;
        project.settings.endpointName = 'delete-entry';
        project.settings.publishedEndpointName = 'delete-entry';
      } else if (publication === 'web-app-only') {
        project.settings.publishedWebApps = [
          {
            uiGraphId: 'app',
            uiGraphName: 'Published app',
            slug: 'delete-entry-app',
            allowedEmails: [],
            publishedAt: '2026-04-08T10:30:00.000Z',
            status: 'published',
          },
        ];
        project.webApps = [
          {
            uiGraphId: 'app',
            name: 'Published app',
            publishedSlug: 'delete-entry-app',
            publishedAt: '2026-04-08T10:30:00.000Z',
            allowedEmails: [],
            status: 'published',
            isMissingFromProject: false,
          },
        ];
      }
      await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
      let deletes = 0;
      await page.route('**/api/workflows/projects', async (route) => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        deletes++;
        await route.fulfill({ status: 500, json: { error: 'Unexpected deletion' } });
      });
      await page.goto('/');
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.locator('.project-row', { hasText: project.name }).click({ button: 'right' });
      const deleteAction = page.getByRole('menuitem', { name: 'Delete project', exact: true });
      await expect(deleteAction).toBeEnabled({ timeout: 2_000 });
      if (publication === 'unpublished_changes') {
        await deleteAction.focus();
        await deleteAction.press('Enter');
      } else {
        await deleteAction.click();
      }
      const modal = page.getByTestId('workflow-project-settings-modal');
      await expect(modal).toBeVisible();
      await expect(
        modal.getByRole('tab', { name: fullyUnpublished ? 'Danger zone' : 'Endpoint', exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      const deleteButton = modal.getByRole('button', { name: 'Delete project', exact: true });
      if (fullyUnpublished) {
        await expect(deleteButton).toBeEnabled();
      } else {
        await expect(deleteButton).toHaveCount(0);
        await modal.getByRole('tab', { name: 'Danger zone', exact: true }).click();
        await expect(deleteButton).toBeDisabled();
      }
      expect(deletes).toBe(0);
      await modal.getByRole('button', { name: 'Close project settings' }).click();
      await page.locator('.project-row', { hasText: project.name }).click();
      await openProjectContextMenu(page);
      await page.locator('.active-project-more-button').click();
      await expect(modal.getByRole('tab', { name: 'Endpoint', exact: true })).toHaveAttribute('aria-selected', 'true');
    });
  }

  test('Delete shortcut preserves review guards and manual tab choice while publication details load', async ({
    page,
  }) => {
    const project = createProjectSettingsFixture('delete-entry-stale-tree');
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let releaseReview!: () => void;
    const review = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    await page.route('**/api/workflows/projects/web-apps?**', async (route) => {
      await review;
      await route.fallback();
    });
    try {
      await page.goto('/');
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.locator('.project-row', { hasText: project.name }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Delete project', exact: true }).click();
      const modal = page.getByTestId('workflow-project-settings-modal');
      await expect(modal.getByRole('tab', { name: 'Danger zone', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(modal.getByRole('button', { name: 'Delete project', exact: true })).toBeDisabled();
      await modal.getByRole('tab', { name: 'Endpoint', exact: true }).click();
      project.settings = {
        ...project.settings,
        status: 'published',
        endpointName: 'now-published',
        publishedEndpointName: 'now-published',
      };
      releaseReview();
      await expect(modal.getByRole('button', { name: 'Unpublish', exact: true })).toBeEnabled();
      await expect(modal.getByRole('tab', { name: 'Endpoint', exact: true })).toHaveAttribute('aria-selected', 'true');
      await modal.getByRole('tab', { name: 'Danger zone', exact: true }).click();
      await expect(modal.getByRole('button', { name: 'Delete project', exact: true })).toBeDisabled();
    } finally {
      releaseReview();
    }
  });

  test('endpoint unpublish shows Unpublished while an independent web app remains published', async ({ page }) => {
    const project = createProjectSettingsFixture('endpoint-with-published-app');
    project.settings = {
      status: 'published',
      publicationStatus: 'published',
      publicationVersion: '8',
      endpointName: 'summary',
      publishedEndpointName: 'summary',
      endpointAccess: 'public',
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: [
        {
          uiGraphId: 'ui',
          uiGraphName: 'Summary app',
          slug: 'summary-app',
          allowedEmails: ['operator@example.com'],
          publishedAt: '2026-04-08T10:30:00.000Z',
          status: 'published',
        },
      ],
    };
    project.webApps = [
      {
        uiGraphId: 'ui',
        name: 'Summary app',
        publishedSlug: 'summary-app',
        publishedAt: '2026-04-08T10:30:00.000Z',
        allowedEmails: ['operator@example.com'],
        status: 'published',
        isMissingFromProject: false,
      },
    ];
    project.stats!.webAppCount = 1;
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let unpublishRequests = 0;
    await page.route('**/api/workflows/projects/unpublish', async (route) => {
      const request = route.request().postDataJSON();
      expect(request.preconditions.expectedPublicationVersion).toBe('8');
      expect(request.relativePath).toBe(project.relativePath);
      unpublishRequests++;
      project.settings = {
        ...project.settings,
        status: 'unpublished',
        publicationStatus: 'published',
        publishedEndpointName: '',
        lastPublishedAt: null,
        publicationVersion: '9',
      };
      await route.fulfill({ json: { project } });
    });
    page.on('dialog', (dialog) => void dialog.accept());
    const { modal } = await openProjectSettingsModal(page, project);
    await expect(modal.locator('.project-settings-status-block .project-status-badge')).toHaveText('Published');
    await modal.getByRole('button', { name: 'Unpublish', exact: true }).click();
    await expect(modal.locator('.project-settings-status-block .project-status-badge')).toHaveText('Unpublished');
    await expect(modal.getByText('Workflow is not published as endpoint.', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Unpublish', exact: true })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await expect(modal.locator('.project-settings-status-help')).toHaveCount(0);
    expect(unpublishRequests).toBe(1);
    await modal.getByRole('tab', { name: 'Web apps', exact: true }).click();
    const app = modal.locator('.project-settings-web-app-row', { hasText: 'Summary app' });
    await expect(app.locator('.project-settings-web-app-state')).toHaveText('Published');
    await expect(app.getByRole('button', { name: 'Unpublish', exact: true })).toBeEnabled();
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    await expect(modal.getByRole('button', { name: 'Delete project', exact: true })).toBeDisabled();
  });

  test('deletion stays disabled after unavailable publication reads until a successful review', async ({ page }) => {
    const project = createProjectSettingsFixture('delete-publication-unavailable');
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let failPublicationRead = true;
    let reads = 0;
    await page.route('**/api/workflows/projects/web-apps?**', async (route) => {
      reads++;
      if (failPublicationRead) await route.fulfill({ status: 503, json: { error: 'Publication unavailable' } });
      else await route.fallback();
    });
    const { modal } = await openProjectSettingsModal(page, project);
    await expect(modal.getByRole('alert')).toContainText('Publication state could not be loaded');
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    const deleteButton = modal.getByRole('button', { name: 'Delete project', exact: true });
    await expect(deleteButton).toBeDisabled();
    await modal.getByRole('button', { name: 'Review latest', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await expect(modal.getByRole('alert')).toContainText('Publication state could not be loaded');
    await expect(deleteButton).toBeDisabled();
    failPublicationRead = false;
    await modal.getByRole('button', { name: 'Review latest', exact: true }).click();
    await expect(deleteButton).toBeEnabled();
    await expect(modal.getByRole('alert')).toHaveCount(0);
  });

  test('Danger zone lazily shows incoming connections, incomplete scans and refresh recovery', async ({ page }) => {
    const project = createProjectSettingsFixture('reference-target');
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let requests = 0;
    await page.route('**/api/workflows/projects/references?**', async (route) => {
      requests++;
      const query = new URL(route.request().url()).searchParams;
      expect(query.get('relativePath')).toBe(project.relativePath);
      expect(query.get('projectId')).toBe(project.projectMetadataId);
      await route.fulfill({
        json: {
          projectId: project.projectMetadataId,
          references:
            requests === 1
              ? [
                  {
                    projectId: 'caller',
                    name: 'Story runner',
                    relativePath: 'stories/Story runner.rivet-project',
                    sources: [
                      { kind: 'saved-latest', targetVersions: ['latest', 'project-reference'] },
                      { kind: 'published-web-app', label: 'story-ui', targetVersions: ['published'] },
                    ],
                  },
                ]
              : [],
          checkedProjects: 2,
          totalProjects: 2,
          complete: requests !== 1,
          changedDuringScan: false,
          unreadableProjects: requests === 1 ? [{ name: 'Broken', relativePath: 'Broken.rivet-project' }] : [],
        },
      });
    });
    const { modal } = await openProjectSettingsModal(page, project);
    expect(requests).toBe(0);
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    const references = modal.getByRole('region', { name: 'Projects referencing this project' });
    await expect(references).toContainText('Story runner');
    await expect(references).toContainText('stories/Story runner.rivet-project');
    await expect(references).toContainText('Saved latest → Saved latest, Project reference');
    await expect(references).toContainText('Published web app: story-ui → Published');
    await expect(references.getByRole('alert')).toContainText('This check is incomplete');
    await expect(references.getByRole('alert')).toContainText('Broken.rivet-project');
    await expect(modal.getByRole('button', { name: 'Delete project', exact: true })).toBeEnabled();
    await references.getByRole('button', { name: 'Retry reference check' }).click();
    await expect(references).toHaveCount(0);
    expect(requests).toBe(2);
  });
  test('dynamic Saved latest dependencies do not add publication reminders', async ({ page }) => {
    const project = createProjectSettingsFixture('dynamic-subgraph-dependency');
    project.savedLatestSubgraphProjectIds = ['called-project'];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    const { modal } = await openProjectSettingsModal(page, project);
    await expect(modal.getByRole('note')).toHaveCount(0);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(modal.getByRole('note')).toHaveCount(0);
  });
  test('a nonsequential success version cannot re-arm publication', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-invalid-publication-response');
    project.settings = {
      ...project.settings,
      status: 'published',
      endpointName: 'versioned-endpoint',
      publishedEndpointName: 'versioned-endpoint',
      endpointAccess: 'public',
    };
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let treeReads = 0;
    let publicationReads = 0;
    await page.route('**/api/workflows/tree', async (route) => {
      treeReads++;
      await route.fallback();
    });
    await page.route('**/api/workflows/projects/web-apps?**', async (route) => {
      publicationReads++;
      await route.fallback();
    });
    await page.route(
      '**/api/workflows/projects/endpoint-access',
      async (route) => {
        project.settings.endpointAccess = 'internal';
        project.settings.publicationVersion = '2';
        await route.fulfill({ json: { project } });
      },
      { times: 1 },
    );

    const { modal } = await openProjectSettingsModal(page, project);
    await expect(modal.getByRole('button', { name: 'Internal network only', exact: true })).toBeEnabled();
    const readsBeforeMutation = { tree: treeReads, publication: publicationReads };
    await modal.getByRole('button', { name: 'Internal network only', exact: true }).click();
    await expect(
      page.getByText('The change succeeded, but publication state could not be verified.', { exact: false }),
    ).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Review latest' })).toBeVisible();
    await expect(modal.getByRole('tab', { name: 'Web apps', exact: true })).toBeEnabled();
    // The library/editor also reconcile the tree independently; receipt rejection must still refresh it.
    expect(treeReads).toBeGreaterThan(readsBeforeMutation.tree);
    expect(publicationReads).toBe(readsBeforeMutation.publication);
  });

  for (const invalidToken of ['missing draft revision', 'noncanonical publication version'] as const) {
    test(`coherent display data with ${invalidToken} cannot authorize publication`, async ({ page }) => {
      const project = createProjectSettingsFixture(`review-${invalidToken}`);
      project.settings.endpointName = 'review-endpoint';
      const trackers = createProjectSettingsRouteTrackers();
      await installProjectSettingsRoutes(page, project, trackers);
      if (invalidToken === 'missing draft revision') project.revisionId = '';
      else project.settings.publicationVersion = '01';
      await page.route('**/api/workflows/projects/web-apps?**', (route) =>
        route.fulfill({
          json: createProjectWebAppsResponse(project),
        }),
      );
      const { modal } = await openProjectSettingsModal(page, project);
      await expect(
        page.getByText(
          invalidToken === 'missing draft revision'
            ? 'Publication state is unavailable. Refresh the project before publishing.'
            : 'Publication state is inconsistent. Review the latest project before publishing.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(modal.locator('#workflow-project-endpoint-name')).toHaveValue('review-endpoint');
      await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
      expect(trackers.endpointPublishRequests).toHaveLength(0);
    });
  }

  test('an initial read finishing after close and reopen cannot replace the new review or drafts', async ({ page }) => {
    const project = createProjectSettingsFixture('reopened-review');
    project.settings.endpointName = 'review-endpoint';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    const started = Promise.withResolvers<Request>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    await page.route('**/api/workflows/projects/web-apps?**', async (route) => {
      if (++reads !== 1) return route.fallback();
      const originalProject = structuredClone(project);
      started.resolve(route.request());
      await release.promise;
      await route.fulfill({
        json: createProjectWebAppsResponse(originalProject),
      });
    });
    try {
      const { modal } = await openProjectSettingsModal(page, project);
      const originalRequest = await started.promise;
      await modal.getByRole('button', { name: 'Close project settings' }).click();
      await expect(modal).toHaveCount(0);
      project.revisionId = 'fresh-review';
      project.settings.publicationVersion = '9';
      await showProjectSettingsModal(page, project);
      const publish = modal.getByRole('button', { name: 'Publish', exact: true });
      await expect(publish).toBeEnabled();
      const endpoint = modal.locator('#workflow-project-endpoint-name');
      await endpoint.fill('user-draft-endpoint');
      const lateResponse = page.waitForResponse((response) => response.request() === originalRequest);
      release.resolve();
      expect(await (await lateResponse).finished()).toBeNull();
      await expect(endpoint).toHaveValue('user-draft-endpoint');
      await expect(publish).toBeEnabled();
      expect(reads).toBe(2);
      await publish.click();
      await expect(modal.locator('.project-status-badge.published')).toBeVisible();
      await expect(modal.getByRole('tab', { name: 'Web apps', exact: true })).toBeEnabled();
      expect(reads).toBe(2);
      expect(trackers.endpointPublishRequests).toHaveLength(1);
      expect(trackers.endpointPublishRequests[0]?.preconditions).toEqual({
        expectedProjectId: project.projectMetadataId,
        expectedDraftRevisionId: 'fresh-review',
        expectedPublicationVersion: '9',
      });
      expect(trackers.endpointPublishRequests[0]?.settings?.endpointName).toBe('user-draft-endpoint');
    } finally {
      release.resolve();
    }
  });

  test('a same-path replacement cannot arm publication in the original project settings', async ({ page }) => {
    const original = createProjectSettingsFixture('reviewed-path');
    original.settings.endpointName = 'original-endpoint';
    const replacement = {
      ...original,
      id: 'replacement-owner',
      projectMetadataId: 'replacement-owner',
      revisionId: 'replacement-draft',
    };
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, original, trackers);
    await page.route('**/api/workflows/projects/web-apps?**', (route) =>
      route.fulfill({
        json: createProjectWebAppsResponse(replacement),
      }),
    );
    const { modal } = await openProjectSettingsModal(page, original);
    const publish = modal.getByRole('button', { name: 'Publish', exact: true });
    await expect(modal.getByRole('button', { name: 'Review latest', exact: true })).toBeVisible();
    await expect(publish).toBeDisabled();
    const [response] = await Promise.all([
      page.waitForResponse('**/api/workflows/projects/web-apps?**'),
      modal.getByRole('button', { name: 'Review latest', exact: true }).click(),
    ]);
    expect(await response.finished()).toBeNull();
    await expect(modal.getByRole('button', { name: 'Review latest', exact: true })).toBeVisible();
    await expect(publish).toBeDisabled();
    expect(trackers.endpointPublishRequests).toHaveLength(0);
  });

  test('endpoint access changes cannot approve a newer draft or overwrite an edited endpoint', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-pinned-publication');
    project.settings = {
      ...project.settings,
      status: 'published',
      endpointName: 'pinned-endpoint',
      publishedEndpointName: 'pinned-endpoint',
      endpointAccess: 'public',
    };
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    const { modal } = await openProjectSettingsModal(page, project);
    const endpointInput = modal.locator('#workflow-project-endpoint-name');
    await endpointInput.fill('my-edited-endpoint');
    project.revisionId = 'revision-2';
    project.settings.status = 'unpublished_changes';
    project.settings.endpointName = 'colleague-endpoint';
    // Access may change independently of the saved draft. Its response must not
    // approve that newer draft or replace the locally edited endpoint name.
    await modal.getByRole('button', { name: 'Internal network only', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Internal network only', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(endpointInput).toHaveValue('my-edited-endpoint');
    const update = modal.getByRole('button', { name: 'Update', exact: true });
    await expect(update).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Review latest' })).toBeVisible();
    expect(trackers.endpointPublishRequests).toHaveLength(0);
    await modal.getByRole('button', { name: 'Review latest' }).click();
    await expect(update).toBeEnabled();
    await update.click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible();
    expect(trackers.endpointPublishRequests[0]?.preconditions?.expectedDraftRevisionId).toBe('revision-2');
    expect(trackers.endpointPublishRequests[0]?.settings?.expectedRevisionId).toBeUndefined();
    expect(trackers.endpointPublishRequests[0]?.settings?.endpointName).toBe('my-edited-endpoint');
    expect(project.settings.endpointAccess).toBe('internal');
    // Once the edit is saved, the clean field should follow later server updates.
    project.settings.endpointName = 'later-server-endpoint';
    await modal.getByRole('button', { name: 'External', exact: true }).click();
    await expect(endpointInput).toHaveValue('later-server-endpoint');
  });

  test('reports a tree refresh failure after successful publishing without losing the committed result', async ({
    page,
  }) => {
    const project = createProjectSettingsFixture('codex-publish-refresh');
    project.settings.endpointName = 'refresh-endpoint';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    const { modal } = await openProjectSettingsModal(page, project);
    let failRefresh = false;
    await page.route('**/api/workflows/tree', async (route) => {
      if (!failRefresh) return route.fallback();
      await route.fulfill({ status: 503, json: { error: 'Temporary tree failure' } });
    });
    await page.route(
      '**/api/workflows/projects/publish',
      async (route) => {
        failRefresh = true;
        await route.fallback();
      },
      { times: 1 },
    );
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(
      page.getByText('The change succeeded, but the project list could not refresh. Refresh to see the latest state.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page.locator('.workflow-library-panel')).toContainText(project.name);
    expect(trackers.endpointPublishRequests).toHaveLength(1);
    expect(project.settings.status).toBe('published');
    await expect(page.getByText('Publishing failed because the project changed.', { exact: false })).toHaveCount(0);
  });

  test('stale publishing requires explicit review before retry', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-publish-conflict');
    project.settings.endpointName = 'conflict-endpoint';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    const { modal } = await openProjectSettingsModal(page, project);
    // Commit the competing save after the browser has sent its reviewed revision.
    await page.route(
      '**/api/workflows/projects/publish',
      async (route) => {
        project.revisionId = 'revision-2';
        await route.fallback();
      },
      { times: 1 },
    );
    const publish = modal.getByRole('button', { name: 'Publish', exact: true });
    await publish.click();
    await expect(page.getByText('Publishing failed because the project changed.', { exact: false })).toBeVisible();
    await expect(publish).toBeDisabled();
    expect(trackers.endpointPublishRequests).toHaveLength(1);
    expect(trackers.endpointPublishRequests[0]?.preconditions?.expectedDraftRevisionId).toBe('revision-1');
    expect(project.settings.status).toBe('unpublished');
    await modal.getByRole('button', { name: 'Review latest' }).click();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible();
    expect(trackers.endpointPublishRequests).toHaveLength(2);
    expect(trackers.endpointPublishRequests[1]?.preconditions?.expectedDraftRevisionId).toBe('revision-2');
  });

  test('a newer publication found after web-app publish requires review', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-web-app-post-publish-race');
    project.webApps = [
      {
        uiGraphId: 'ui-graph-race',
        name: 'Race App',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
    ];
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    let reads = 0;
    await page.route('**/api/workflows/projects/web-apps**', async (route) => {
      if (isRouteRequest(route.request(), 'GET', '/api/workflows/projects/web-apps') && ++reads === 2) {
        project.settings.publicationVersion = (BigInt(project.settings.publicationVersion ?? '0') + 1n).toString();
      }
      await route.fallback();
    });

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const row = modal.locator('.project-settings-web-app-row', { hasText: 'Race App' });
    await row.locator('input').fill('my-race-app');
    await row.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(
      modal.getByText('The project or its publication changed during your attempt.', { exact: false }),
    ).toBeVisible();
    await expect(row.locator('input')).toHaveValue('my-race-app');
    await expect(row.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    expect(trackers.webAppPublishRequests).toHaveLength(1);
  });

  test('an incoherent publication read leaves edited web-app fields intact', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-incoherent-publication-read');
    project.webApps = [
      {
        uiGraphId: 'ui-graph-incoherent',
        name: 'Incoherent App',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let reads = 0;
    await page.route('**/api/workflows/projects/web-apps**', async (route) => {
      if (!isRouteRequest(route.request(), 'GET', '/api/workflows/projects/web-apps') || ++reads !== 2) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          ...createProjectWebAppsResponse(project),
          project: { ...project, settings: { ...project.settings, publicationVersion: 'malformed' } },
        },
      });
    });

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const row = modal.locator('.project-settings-web-app-row', { hasText: 'Incoherent App' });
    await row.locator('input').fill('my-incoherent-app');
    await row.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Publication state is inconsistent.', { exact: false })).toBeVisible();
    await expect(row.locator('input')).toHaveValue('my-incoherent-app');
    await expect(row.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  });

  test('reviewing a conflict updates clean web-app fields without discarding edited fields', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-web-app-review-drafts');
    project.settings = {
      ...project.settings,
      status: 'published',
      endpointName: 'review-endpoint',
      publishedEndpointName: 'review-endpoint',
      endpointAccess: 'public',
    };
    project.webApps = [
      {
        uiGraphId: 'ui-graph-edited',
        name: 'Edited App',
        publishedSlug: 'edited-app',
        publishedAt: '2026-04-08T10:35:00.000Z',
        allowedEmails: ['edited@example.com'],
        status: 'published',
        isMissingFromProject: false,
      },
      {
        uiGraphId: 'ui-graph-clean',
        name: 'Clean App',
        publishedSlug: 'clean-app',
        publishedAt: '2026-04-08T10:35:00.000Z',
        allowedEmails: ['clean@example.com'],
        status: 'published',
        isMissingFromProject: false,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers(), {
      routeConfig: { webAppsAuthMode: 'oauth' },
    });
    let publicationReads = 0;
    await page.route('**/api/workflows/projects/web-apps?**', async (route) => {
      publicationReads++;
      await route.fallback();
    });
    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const edited = modal.locator('.project-settings-web-app-row', { hasText: 'Edited App' });
    const clean = modal.locator('.project-settings-web-app-row', { hasText: 'Clean App' });
    const initialReads = publicationReads;
    await edited.locator('input').fill('my-edited-app');
    await edited.locator('textarea').fill('mine@example.com');
    expect(publicationReads).toBe(initialReads);

    project.webApps![1] = {
      ...project.webApps![1]!,
      publishedSlug: 'colleague-app',
      allowedEmails: ['colleague@example.com'],
    };
    project.settings.publicationVersion = '1';
    await modal.getByRole('tab', { name: 'Endpoint' }).click();
    await modal.getByRole('button', { name: 'Internal network only', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Review latest' })).toBeVisible();
    await modal.getByRole('button', { name: 'Review latest' }).click();
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(edited.locator('input')).toHaveValue('my-edited-app');
    await expect(edited.locator('textarea')).toHaveValue('mine@example.com');
    await expect(clean.locator('input')).toHaveValue('colleague-app');
    await expect(clean.locator('textarea')).toHaveValue('colleague@example.com');
    expect(publicationReads).toBe(initialReads + 1);
  });

  test('a failed post-publish web-app refresh preserves local drafts', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-web-app-post-publish-refresh');
    project.webApps = [
      {
        uiGraphId: 'ui-graph-refresh',
        name: 'Refresh App',
        publishedSlug: null,
        publishedAt: null,
        status: 'unpublished',
        isMissingFromProject: false,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    let reads = 0;
    await page.route('**/api/workflows/projects/web-apps**', async (route) => {
      if (isRouteRequest(route.request(), 'GET', '/api/workflows/projects/web-apps') && ++reads === 2) {
        await route.fulfill({ status: 503, json: { error: 'Temporary read failure' } });
        return;
      }
      await route.fallback();
    });

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const row = modal.locator('.project-settings-web-app-row', { hasText: 'Refresh App' });
    await row.locator('input').fill('my-refresh-app');
    await row.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(
      page.getByText('The change succeeded, but publication state could not refresh.', { exact: false }),
    ).toBeVisible();
    await expect(row.locator('input')).toHaveValue('my-refresh-app');
    await expect(modal.getByRole('button', { name: 'Review latest' })).toBeVisible();
  });

  test('web-app unpublish does not approve a newer draft saved during the command', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-web-app-unpublish-draft-race');
    project.webApps = [
      {
        uiGraphId: 'ui-graph-unpublish-race',
        name: 'Unpublish Race App',
        publishedSlug: 'unpublish-race-app',
        publishedAt: '2026-04-08T10:35:00.000Z',
        status: 'published',
        isMissingFromProject: false,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    await page.route(
      '**/api/workflows/projects/web-apps/unpublish',
      async (route) => {
        project.revisionId = 'revision-2';
        await route.fallback();
      },
      { times: 1 },
    );
    page.on('dialog', (dialog) => void dialog.accept());

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    const row = modal.locator('.project-settings-web-app-row', { hasText: 'Unpublish Race App' });
    await row.getByRole('button', { name: 'Unpublish' }).click();
    await expect(
      modal.getByText('The project or its publication changed during your attempt.', { exact: false }),
    ).toBeVisible();
    await expect(row.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Review latest' }).click();
    await expect(row.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
  });

  test('changes endpoint access immediately even with unpublished graph changes', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-endpoint-access');
    project.settings = {
      status: 'unpublished_changes',
      endpointName: 'draft-endpoint',
      publishedEndpointName: 'existing-endpoint',
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: [],
    };
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers, {
      routeConfig: {
        internalPublishedWorkflowsBaseUrl: 'http://rivet-execution.internal:80/internal/workflows',
        internalLatestWorkflowsBaseUrl: 'http://rivet-api.internal:80/internal/workflows-latest',
      },
    });

    const { modal } = await openProjectSettingsModal(page, project);
    const access = modal.getByRole('group', { name: 'Endpoint access' });
    await expect(modal.getByText('Changes take effect immediately', { exact: true })).toBeVisible();
    await expect(modal.getByText('Endpoint access', { exact: true })).toHaveAttribute(
      'title',
      'Controls where the endpoint can be reached. Bearer-key requirements are configured separately in Rivet Server settings.',
    );
    await expect(access.getByRole('button', { name: 'External', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await access.getByRole('button', { name: 'Internal network only' }).click();
    await expect(access.getByRole('button', { name: 'Internal network only' })).toHaveAttribute('aria-pressed', 'true');
    await expect(modal).toContainText('http://rivet-execution.internal:80/internal/workflows/existing-endpoint');
    await expect(modal).toContainText('The unpublished changes are accessible on');
    await expect(modal).toContainText('http://rivet-api.internal:80/internal/workflows-latest/draft-endpoint');
    await expect(modal.locator('.project-settings-endpoint-access')).toHaveCSS('border-bottom-style', 'solid');
    await expect(modal).toContainText('Unpublished changes');
    expect(trackers.endpointAccessRequests).toMatchObject([{ relativePath: project.relativePath, access: 'internal' }]);
    expect(trackers.endpointPublishRequests).toEqual([]);

    await access.getByRole('button', { name: 'External', exact: true }).click();
    await expect(access.getByRole('button', { name: 'External', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(modal).toContainText('/workflows/existing-endpoint');
    await expect(modal).toContainText('/workflows-latest/draft-endpoint');
    expect(trackers.endpointAccessRequests).toHaveLength(2);
  });

  test('distinguishes active LLM profile suspensions from recovery states', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-project-settings-llm-health');
    const now = Date.now();
    const healthEntries = [
      {
        identity: {
          key: 'suspended-profile',
          projectId: project.id,
          profileNodeId: null,
          profileName: 'Primary route',
          provider: 'openai',
          model: 'suspended-model',
          configurationFingerprint: 'sha256:suspended',
        },
        state: 'open',
        failureCount: 3,
        openUntil: now + 60_000,
        updatedAt: now,
        contributingRuns: [
          {
            occurredAt: now - 1_000,
            contributionCount: 1,
            triggeredSuspension: true,
            availability: 'available',
            recordingId: 'suspension-recording',
          },
        ],
      },
      {
        identity: {
          key: 'recovering-profile',
          projectId: project.id,
          profileNodeId: null,
          provider: 'openai',
          model: 'recovering-model',
          configurationFingerprint: 'sha256:recovering',
        },
        state: 'half-open',
        failureCount: 3,
        halfOpenLeaseUntil: now + 60_000,
        updatedAt: now - 1,
      },
    ];
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());
    await page.route('**/api/workflows/llm-profile-health/admin?projectId=*', async (route) => {
      if (!isRouteRequest(route.request(), 'GET', '/api/workflows/llm-profile-health/admin')) {
        await route.fallback();
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(healthEntries),
      });
    });

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'LLM profile suspension' }).click();

    const suspendedRow = modal.locator('.project-settings-llm-health-row-suspended');
    const recoveryRow = modal.locator('.project-settings-llm-health-row-recovery');
    await expect(suspendedRow).toContainText('suspended until');
    await expect(suspendedRow).toContainText('Primary route');
    await expect(suspendedRow).toContainText('Contributing recordings');
    await expect(suspendedRow).toContainText('suspension threshold reached');
    await expect(suspendedRow.getByRole('button', { name: 'Open contributing run recording' })).toBeVisible();
    await expect(recoveryRow).toContainText('recovery attempt in progress');
    await expect(recoveryRow).toContainText('This suspension predates recording links');

    const [suspendedColor, recoveryColor] = await Promise.all([
      suspendedRow.evaluate((element) => getComputedStyle(element).borderLeftColor),
      recoveryRow.evaluate((element) => getComputedStyle(element).borderLeftColor),
    ]);
    expect(suspendedColor).not.toBe(recoveryColor);
  });

  test('publish controls validate endpoints and keep rename/delete ownership clear', async ({ page }) => {
    const unique = 'codex-project-settings-fixture';
    const endpointName = 'codex-project-settings-endpoint';
    const project = createProjectSettingsFixture(unique);
    await installProjectSettingsRoutes(page, project, createProjectSettingsRouteTrackers());

    const { modal } = await openProjectSettingsModal(page, project);
    const projectSettingsSections = modal.getByRole('tablist', { name: 'Project settings sections' });
    await expect(projectSettingsSections).toHaveAttribute('aria-orientation', 'vertical');
    await expect(modal.locator('.project-settings-modal-header-row').getByRole('tablist')).toHaveCount(0);
    await expect(modal.locator('.project-settings-modal-content').getByRole('tablist')).toHaveCount(1);
    const tabs = projectSettingsSections.getByRole('tab');
    // Read both rectangles in one frame; the entering modal moves between protocol calls.
    const [first, second] = await tabs.evaluateAll((elements) =>
      elements.slice(0, 2).map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    if (!first || !second) throw new Error('Expected the first two project settings tabs.');
    expect(second.y).toBeGreaterThan(first.y + first.height);
    expect(second.x).toBeCloseTo(first.x);
    expect(second.width).toBeCloseTo(first.width);
    await expect(projectSettingsSections.getByRole('tab', { name: 'Endpoint' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const sectionSwitcherBox = await projectSettingsSections.boundingBox();
    const modalBox = await modal.boundingBox();
    expect(sectionSwitcherBox).not.toBeNull();
    expect(modalBox).not.toBeNull();
    expect(sectionSwitcherBox!.width).toBeLessThan(modalBox!.width);
    await expect(page.locator('.workflow-project-context-menu')).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Rename project' })).toHaveCount(0);
    await expect(modal.locator('.project-settings-title-input input')).toHaveCount(0);

    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await expect(deleteButton).toHaveCount(0);
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    await expect(modal).toContainText('permanent and cannot be undone');
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeEnabled();
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(modal).toContainText('No web apps in the project.');
    await expect(deleteButton).toHaveCount(0);
    await modal.getByRole('tab', { name: 'Endpoint' }).click();
    await expect(deleteButton).toHaveCount(0);

    const endpointInput = modal.locator('#workflow-project-endpoint-name');
    await expect(endpointInput).toBeVisible();
    await expect(modal.locator('.active-project-status-row')).toContainText('Workflow is not published as endpoint.');
    const unpublishedStatusNoteFontSize = await modal
      .locator('.project-settings-status-note')
      .evaluate((element) => getComputedStyle(element).fontSize);
    const unpublishedStatusNoteCenterOffset = await modal.locator('.active-project-status-row').evaluate((row) => {
      const badge = row.querySelector('.project-status-badge');
      const note = row.querySelector('.project-settings-status-note');
      if (!(badge instanceof HTMLElement) || !(note instanceof HTMLElement)) {
        throw new Error('Expected unpublished workflow status badge and note');
      }

      const badgeRect = badge.getBoundingClientRect();
      const noteRect = note.getBoundingClientRect();
      return Math.abs(badgeRect.top + badgeRect.height / 2 - (noteRect.top + noteRect.height / 2));
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
    const lastPublishedAtFontSize = await modal
      .locator('.project-settings-last-published-at')
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(lastPublishedAtFontSize).toBe(unpublishedStatusNoteFontSize);
    const lastPublishedAtCenterOffset = await modal.locator('.active-project-status-row').evaluate((row) => {
      const badge = row.querySelector('.project-status-badge');
      const timestamp = row.querySelector('.project-settings-last-published-at');
      if (!(badge instanceof HTMLElement) || !(timestamp instanceof HTMLElement)) {
        throw new Error('Expected published workflow status badge and timestamp');
      }

      const badgeRect = badge.getBoundingClientRect();
      const timestampRect = timestamp.getBoundingClientRect();
      return Math.abs(badgeRect.top + badgeRect.height / 2 - (timestampRect.top + timestampRect.height / 2));
    });
    expect(Math.abs(lastPublishedAtCenterOffset - unpublishedStatusNoteCenterOffset)).toBeLessThanOrEqual(1);
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await endpointInput.fill(`${endpointName}-renamed`);
    await expect(modal.locator('.project-settings-status-help')).toContainText(`/workflows/${endpointName}`);
    await expect(modal.locator('.project-settings-status-help')).not.toContainText(
      `/workflows/${endpointName}-renamed`,
    );
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await endpointInput.fill(endpointName);
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Unpublish' })).toHaveCSS('margin-left', '8px');
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    await expect(deleteButton).toBeVisible();
    await expect(deleteButton).toBeDisabled();
    await modal.getByRole('tab', { name: 'Endpoint' }).click();

    page.once('dialog', (dialog) => dialog.accept());
    await modal.getByRole('button', { name: 'Unpublish' }).click();
    await expect(modal.locator('.project-status-badge.unpublished')).toBeVisible({ timeout: 30_000 });
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
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

    const { modal: nextModal } = await showProjectSettingsModal(page, nextProject);
    const endpointInput = nextModal.locator('#workflow-project-endpoint-name');
    await endpointInput.fill(endpointName);
    await expect(nextModal.locator('.project-settings-error')).toHaveCount(0);
    await expect(nextModal.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    await nextModal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(nextModal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });
    await expect(nextModal.locator('.project-settings-endpoint-code')).toContainText(endpointName);
  });

  test('endpoint publication requires a selected Main Graph', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-project-settings-no-main-graph');
    project.hasMainGraph = false;
    const routeTrackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, routeTrackers);

    const { modal } = await openProjectSettingsModal(page, project);

    await expect(modal.locator('.project-settings-error')).toContainText(
      'Choose a Main Graph before publishing this endpoint.',
    );
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    expect(routeTrackers.endpointPublishRequests).toEqual([]);
  });

  test('endpoint update requires a selected Main Graph', async ({ page }) => {
    const project = createProjectSettingsFixture('codex-project-settings-published-no-main-graph');
    project.hasMainGraph = false;
    project.settings = {
      status: 'published',
      endpointName: 'requires-main-graph',
      lastPublishedAt: '2026-04-08T10:30:00.000Z',
      publishedWebApps: [],
    };
    const routeTrackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, routeTrackers);

    const { modal } = await openProjectSettingsModal(page, project);

    await expect(modal.locator('.project-settings-error')).toContainText(
      'Choose a Main Graph before publishing this endpoint.',
    );
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    expect(routeTrackers.endpointPublishRequests).toEqual([]);
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
    await expect(page.locator('.workflow-project-context-menu')).toHaveCount(0);
    await expect(modal.getByRole('tab', { name: 'Endpoint' })).toHaveAttribute('aria-selected', 'true');
    await modal.getByRole('tab', { name: 'Web apps' }).click();
    await expect(modal.getByRole('tab', { name: 'Web apps' })).toHaveAttribute('aria-selected', 'true');
    const deleteButton = modal.getByRole('button', { name: 'Delete project' });
    await modal.getByRole('tab', { name: 'Danger zone' }).click();
    await expect(deleteButton).toBeDisabled();
    await expect(modal).toContainText('Unpublish the endpoint and all web apps');
    const deleteHint = modal.getByText('Unpublish the endpoint and all web apps before deleting this project.', {
      exact: true,
    });
    await expect(deleteHint).toBeVisible();
    const deleteBounds = await deleteButton.boundingBox();
    const hintBounds = await deleteHint.boundingBox();
    expect(deleteBounds).not.toBeNull();
    expect(hintBounds).not.toBeNull();
    expect(hintBounds!.y).toBeGreaterThanOrEqual(deleteBounds!.y + deleteBounds!.height);
    await modal.getByRole('tab', { name: 'Web apps' }).click();

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
    await expect(gammaRow.locator('.project-settings-web-app-state.unpublished_changes')).toHaveText(
      'Unpublished changes',
    );
    await expect(staleRow.locator('.project-settings-web-app-state.unpublished_changes')).toHaveText(
      'Unpublished changes',
    );
    await expect(gammaRow.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(gammaRow).toContainText('/custom-apps/gamma-reporter');
    await expect(gammaRow).toContainText('/custom-apps-latest/gamma-reporter');
    await expect(staleRow).toContainText('/custom-apps/legacy-tool');
    await expect(staleRow).not.toContainText('/custom-apps-latest/legacy-tool');
    await gammaRow.getByRole('button', { name: 'Update', exact: true }).click();
    await expect.poll(() => routeTrackers.webAppPublishRequests.length).toBe(1);
    expect(routeTrackers.webAppPublishRequests[0]).toMatchObject({
      relativePath: project.relativePath,
      publications: [{ uiGraphId: 'ui-graph-gamma', slug: 'gamma-reporter', allowedEmails: [] }],
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
    expect(routeTrackers.webAppPublishRequests[1]).toMatchObject({
      relativePath: project.relativePath,
      publications: [{ uiGraphId: 'ui-graph-alpha', slug: 'alpha-helper', allowedEmails: [] }],
    });
    await betaRow.getByRole('button', { name: 'Publish', exact: true }).click();

    await expect(webAppSection.locator('.project-settings-web-app-state')).toHaveCount(4);
    await expect(alphaRow).toContainText('Published');
    await expect(betaRow).toContainText('Published');
    await expect(deleteButton).toHaveCount(0);
    await expect(alphaRow.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(alphaRow).toContainText('The web app is accessible via the endpoint on');
    await expect(alphaRow).toContainText('/custom-apps/alpha-helper');
    await expect(alphaRow).not.toContainText('/custom-apps-latest/alpha-helper');
    const currentOrigin = await page.evaluate(() => window.location.origin);
    const publishedAppLink = alphaRow.getByRole('link', { name: 'Open /custom-apps/alpha-helper in a new tab' });
    await expect(publishedAppLink).toHaveAttribute('href', `${currentOrigin}/custom-apps/alpha-helper`);
    await expect(publishedAppLink).toHaveAttribute('target', '_blank');
    await expect(
      alphaRow.getByRole('link', { name: 'Open /custom-apps-latest/alpha-helper in a new tab' }),
    ).toHaveCount(0);
    await expect(alphaRow.getByRole('button', { name: 'Unpublish' })).toHaveCSS('margin-left', '8px');
    await alphaRow.locator('input').fill('alpha-helper-renamed');
    await expect(alphaRow.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(alphaRow).toContainText('/custom-apps/alpha-helper');
    await expect(alphaRow).not.toContainText('/custom-apps/alpha-helper-renamed');
    await expect.poll(() => routeTrackers.webAppPublishRequests.length).toBe(3);
    expect(routeTrackers.webAppPublishRequests[2]).toMatchObject({
      relativePath: project.relativePath,
      publications: [{ uiGraphId: 'ui-graph-beta', slug: 'beta-console', allowedEmails: [] }],
    });
    await expect(staleRow.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
    await expect(staleRow.getByRole('button', { name: 'Update', exact: true })).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    await alphaRow.getByRole('button', { name: 'Unpublish' }).click();
    await expect.poll(() => routeTrackers.webAppUnpublishRequests.length).toBe(1);
    expect(routeTrackers.webAppUnpublishRequests).toMatchObject([
      {
        relativePath: project.relativePath,
        uiGraphId: 'ui-graph-alpha',
      },
    ]);
    await expect(alphaRow.locator('.project-settings-web-app-state')).toHaveText('Not published');
    await expect(betaRow.locator('.project-settings-web-app-state')).toHaveText('Published');
    await expect(deleteButton).toHaveCount(0);

    page.once('dialog', (dialog) => dialog.accept());
    await staleRow.getByRole('button', { name: 'Unpublish' }).click();
    await expect.poll(() => routeTrackers.webAppUnpublishRequests.length).toBe(2);
    expect(routeTrackers.webAppUnpublishRequests[1]).toMatchObject({
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
});
