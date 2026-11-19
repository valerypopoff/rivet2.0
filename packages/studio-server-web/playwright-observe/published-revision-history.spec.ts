import { expect, test, type Page, type Route } from '@playwright/test';
import {
  createBuiltInRegistry,
  getGraphBoundary,
  serializeProject,
  type GraphId,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-core';
import { authenticateIfNeeded, waitForDashboardReady } from './helpers/hostedEditorObserve';
import {
  createProjectSettingsFixture,
  createProjectSettingsRouteTrackers,
  installProjectSettingsRoutes,
  openProjectSettingsModal,
  showProjectSettingsModal,
} from './helpers/projectSettingsObserve';
import type { WorkflowProjectItem } from '../dashboard/types';

async function expectHistoryReadCancelled(
  page: Page,
  read: 'preview-tree' | 'preview',
  startPreview: () => Promise<void>,
  supersedePreview: () => Promise<void>,
) {
  const url = `**/api/workflows/projects/published-versions/${read}`;
  const release = Promise.withResolvers<void>();
  await page.route(
    url,
    async (route) => {
      await release.promise;
      await route.fallback().catch(() => undefined);
    },
    { times: 1 },
  );

  try {
    const [request] = await Promise.all([page.waitForRequest(url, { timeout: 10_000 }), startPreview()]);
    const [cancelled] = await Promise.all([
      page.waitForEvent('requestfailed', { predicate: (failed) => failed === request, timeout: 10_000 }),
      supersedePreview().finally(() => release.resolve()),
    ]);
    expect(cancelled.failure()?.errorText).toBe('net::ERR_ABORTED');
  } finally {
    release.resolve();
  }
}

test.describe('Published revision history', () => {
  test('history mutations lock navigation and a failed restore refresh requires fresh review', async ({ page }) => {
    const project = createProjectSettingsFixture('history-restore-refresh');
    project.settings.status = 'published';
    project.settings.endpointName = 'history-restore-refresh';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    const history = modal.getByRole('tabpanel', { name: 'Published revision history' });

    const star = Promise.withResolvers<void>();
    await page.route(
      '**/api/workflows/projects/published-versions/star',
      async (route) => {
        await star.promise;
        await route.fallback();
      },
      { times: 1 },
    );
    try {
      await history.getByRole('button', { name: 'Star published version' }).first().click();
      await expect(modal.getByRole('tab', { name: 'Endpoint', exact: true })).toBeDisabled();
      await expect(modal.getByRole('button', { name: 'Close project settings' })).toBeDisabled();
    } finally {
      star.resolve();
    }
    await expect(modal.getByRole('tab', { name: 'Endpoint', exact: true })).toBeEnabled();

    let failRefresh = false;
    await page.route('**/api/workflows/tree', async (route) => {
      if (!failRefresh) return route.fallback();
      await route.fulfill({ status: 503, json: { error: 'Temporary tree failure' } });
    });
    await page.route(
      '**/api/workflows/projects/published-versions/restore',
      async (route) => {
        failRefresh = true;
        await route.fallback();
      },
      { times: 1 },
    );
    page.once('dialog', (dialog) => dialog.accept());
    await history.getByRole('button', { name: 'Restore' }).first().click();
    await expect.poll(() => trackers.publishedVersionRestoreRequests.length).toBe(1);
    await expect(modal.getByRole('tab', { name: 'Endpoint', exact: true })).toBeEnabled();
    await modal.getByRole('tab', { name: 'Endpoint', exact: true }).click();
    await modal.locator('#workflow-project-endpoint-name').fill('reviewed-restored-name');
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Unpublish', exact: true })).toBeDisabled();
    failRefresh = false;
    await modal.getByRole('button', { name: 'Review latest', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
    await expect(modal.getByRole('button', { name: 'Unpublish', exact: true })).toBeEnabled();
  });

  test('legacy capture confirms unavailable rollback and reconciles a lost publish response', async ({ page }) => {
    const project = createProjectSettingsFixture('legacy-capture-reviewed');
    project.settings.status = 'published';
    project.settings.endpointName = project.settings.publishedEndpointName = 'legacy-endpoint';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers, { loseAcknowledgement: 'publish' });
    const reviewToken = 'a'.repeat(64);
    await page.route('**/api/workflows/projects/endpoint-release-review', (route) =>
      route.fulfill({
        json: {
          token: reviewToken,
          projects: [{ projectId: project.projectMetadataId, artifactId: project.revisionId, fromDraft: true }],
          missingRollback: true,
        },
      }),
    );
    await page.route('**/api/workflows/projects/reference-overview', (route) =>
      route.fulfill({
        json: {
          complete: true,
          bundles: [],
          endpoints: [{
            projectId: project.projectMetadataId,
            coverage: project.settings.publicationVersion === '0' ? 'project-only' : 'complete',
            dependencies: [],
            canCaptureRelease: project.settings.publicationVersion === '0',
          }],
        },
      }),
    );
    const { modal } = await openProjectSettingsModal(page, project);
    await expect(modal.getByText('Update this endpoint to track dependencies', { exact: true })).toBeVisible();
    const update = modal.getByRole('button', { name: 'Update', exact: true });
    await expect(update).toBeEnabled();
    const dismissed = page.waitForEvent('dialog');
    page.once('dialog', (dialog) => dialog.dismiss());
    await update.click();
    expect((await dismissed).message()).toContain('cannot be captured for rollback');
    await expect(update).toBeEnabled();
    expect(trackers.endpointPublishRequests).toHaveLength(0);

    page.once('dialog', (dialog) => dialog.accept());
    await Promise.all([
      page.waitForResponse('**/api/workflows/tree', { timeout: 10_000 }),
      update.click(),
    ]);
    await expect(modal.getByText('The publication outcome could not be confirmed.', { exact: false })).toBeVisible();
    await expect(update).toBeDisabled();
    expect(trackers.endpointPublishRequests).toHaveLength(1);
    expect(trackers.endpointPublishRequests[0]?.settings).toMatchObject({
      releaseReviewToken: reviewToken,
      acknowledgeMissingRollback: true,
    });
    expect(project.settings.publicationVersion).toBe('1');
    await modal.getByRole('button', { name: 'Review latest', exact: true }).click();
    await expect(modal.getByText('The publication outcome could not be confirmed.', { exact: false })).toHaveCount(0);
    await expect(update).toBeDisabled();
    expect(trackers.endpointPublishRequests).toHaveLength(1);
  });

  test('a JSON success response without a published project requires fresh review', async ({ page }) => {
    const project = createProjectSettingsFixture('incomplete-publish');
    project.settings.endpointName = 'incomplete-publish';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers, { incompleteAcknowledgement: 'publish' });
    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(modal.getByText('The publication outcome could not be confirmed.', { exact: false })).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    expect(trackers.endpointPublishRequests).toHaveLength(1);
    await modal.getByRole('button', { name: 'Review latest', exact: true }).click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible();
    expect(trackers.endpointPublishRequests).toHaveLength(1);
  });

  test('history Restore confirms the reviewed address and can reconcile an incomplete response', async ({ page }) => {
    const project = createProjectSettingsFixture('history-reviewed-address');
    project.settings.status = 'published';
    project.settings.endpointName = 'draft-address';
    project.settings.publishedEndpointName = 'previous-live-address';
    project.settings.endpointAccess = 'internal';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers, { incompleteAcknowledgement: 'restore' });
    const { modal } = await openProjectSettingsModal(page, project);

    // The history tab reviews the latest route and version even if the tree is older.
    project.settings.publishedEndpointName = 'current-live-address';
    project.settings.publicationVersion = '1';
    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    const history = modal.getByRole('tabpanel', { name: 'Published revision history' });
    let confirmation = '';
    page.once('dialog', async (dialog) => {
      confirmation = dialog.message();
      await dialog.accept();
    });
    await history.getByRole('button', { name: 'Restore' }).nth(1).click();
    await expect(history.getByText('The restore outcome could not be confirmed.')).toBeVisible();
    expect(confirmation).toContain('at the current-live-address endpoint');
    expect(trackers.publishedVersionRestoreRequests).toMatchObject([
      { versionId: 'published-version-2', preconditions: { expectedPublicationVersion: '1' } },
    ]);
    await history.getByRole('button', { name: 'Review latest', exact: true }).click();
    const current = history.getByRole('listitem').first();
    await expect(current).toContainText('Current');
    await expect(current).toContainText('current-live-address');
    expect(project.settings.endpointName).toBe('draft-address');
    expect(project.settings.endpointAccess).toBe('internal');
    expect(trackers.publishedVersionRestoreRequests).toHaveLength(1);
  });

  test('an incomplete release review cannot submit Publish', async ({ page }) => {
    const project = createProjectSettingsFixture('incomplete-release-review');
    project.settings.endpointName = 'incomplete-release-review';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, project, trackers);
    await page.route('**/api/workflows/projects/endpoint-release-review', (route) =>
      route.fulfill({
        json: {
          token: 'reviewed-release',
          projects: [
            { projectId: project.projectMetadataId, artifactId: project.revisionId, fromDraft: true },
            { projectId: 'dependency-id', artifactId: 'dependency-revision' },
          ],
          missingRollback: false,
        },
      }),
    );

    const { modal } = await openProjectSettingsModal(page, project);
    await modal.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('The endpoint release review is incomplete. Review the project again.')).toBeVisible();
    expect(trackers.endpointPublishRequests).toHaveLength(0);
  });

  test('history publication checks dependency edits that arrive during release review', async ({ page }) => {
    const root = createProjectSettingsFixture('release-review-owner');
    const target = createProjectSettingsFixture('release-review-dependency');
    root.settings.status = 'published';
    root.settings.endpointName = 'release-review-current';
    root.settings.publishedEndpointName = 'release-review-current';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, [root, target], trackers);
    await page.addInitScript(() => {
      if (window === window.top) {
        window.addEventListener('message', (event) => {
          if (event.data?.type === 'editor-ready') {
            document.documentElement.dataset.editorInstance = event.data.editorInstanceId;
          }
        });
      }
    });
    await page.route('**/api/workflows/projects/reference-overview', (route) =>
      route.fulfill({
        json: {
          complete: true,
          bundles: [],
          endpoints: [
            {
              projectId: root.projectMetadataId,
              coverage: 'complete',
              dependencies: [
                {
                  projectId: target.projectMetadataId,
                  name: target.name,
                  relativePath: target.relativePath,
                  changed: false,
                  unavailable: false,
                },
              ],
            },
          ],
        },
      }),
    );
    const review = Promise.withResolvers<void>();
    await page.route('**/api/workflows/projects/endpoint-release-review', async (route) => {
      await review.promise;
      await route.fulfill({
        json: {
          token: 'reviewed-release',
          projects: [
            { projectId: root.projectMetadataId, artifactId: root.revisionId, fromDraft: true },
            { projectId: target.projectMetadataId, artifactId: target.revisionId, fromDraft: true },
          ],
          missingRollback: false,
        },
      });
    });

    const { modal } = await openProjectSettingsModal(page, root);
    const editorDocument = page.frameLocator('iframe.dashboard-editor-frame').locator('html');
    const editorInstanceId = await page.locator('html').getAttribute('data-editor-instance');
    expect(editorInstanceId).toBeTruthy();
    await modal.locator('#workflow-project-endpoint-name').fill('release-review-next');
    try {
      await Promise.all([
        page.waitForRequest('**/api/workflows/projects/endpoint-release-review', { timeout: 10_000 }),
        modal.getByRole('button', { name: 'Update', exact: true }).click(),
      ]);
      await editorDocument.evaluate(
        (_, { editorInstanceId, projectId }) =>
          new Promise<void>((resolve) => {
            const received = (event: MessageEvent) => {
              if (
                event.source === window &&
                event.origin === location.origin &&
                event.data?.type === 'editable-dirty-projects' &&
                event.data.editorInstanceId === editorInstanceId &&
                event.data.projectIds.includes(projectId)
              ) {
                parent.removeEventListener('message', received);
                resolve();
              }
            };
            parent.addEventListener('message', received);
            parent.postMessage(
              { type: 'editable-dirty-projects', editorInstanceId, projectIds: [projectId] },
              location.origin,
            );
          }),
        { editorInstanceId, projectId: target.projectMetadataId! },
      );
    } finally {
      review.resolve();
    }
    await expect(page.getByText('Save the edited projects before publishing this endpoint.')).toBeVisible();
    expect(trackers.endpointPublishRequests).toHaveLength(0);
    await expect(modal.getByText('Published', { exact: true })).toBeVisible();

    await modal.getByRole('button', { name: 'Close project settings' }).click();
    const active = page.locator('.active-project-section');
    await expect(active.getByText('Published', { exact: true })).toBeVisible();
    await expect(active.getByRole('button', { name: 'Changed referenced projects (1)', exact: true })).toHaveCount(0);
    const targetRow = page.locator('.project-row', { hasText: target.name });
    await expect(targetRow.getByRole('img', { name: 'Used by a published endpoint' })).toBeVisible();
  });

  test('saved dependency changes update endpoint markers and bundle reference details open the project', async ({
    page,
  }) => {
    const bundleId = 'test-bundle-id';
    const savedAt = '2026-10-20T12:00:00.000Z';
    const inBundle = (name: string) => {
      const project = createProjectSettingsFixture(name);
      project.relativePath = `Bundle/${project.fileName}`;
      project.absolutePath = `/managed/workflows/${project.relativePath}`;
      project.bundleId = bundleId;
      return project;
    };
    const root = inBundle('published-owner');
    root.settings.status = 'published';
    root.settings.endpointName = 'owner';
    root.stats!.webAppCount = 1;
    root.webApps = [{
      uiGraphId: 'owner-web-app',
      name: 'Owner web app',
      publishedSlug: null,
      publishedAt: null,
      status: 'unpublished',
      isMissingFromProject: false,
      allowedEmails: [],
    }];
    const isOwnerWebAppRead = (url: string) => {
      const { pathname, searchParams } = new URL(url);
      return pathname === '/api/workflows/projects/web-apps' && searchParams.get('relativePath') === root.relativePath;
    };
    let ownerWebAppReads = 0;
    page.on('request', (request) => {
      if (isOwnerWebAppRead(request.url())) ownerWebAppReads++;
    });
    const helper = inBundle('bundle-helper');
    const external = createProjectSettingsFixture('shared-library');
    external.relativePath = `Library/${external.fileName}`;
    external.absolutePath = `/managed/workflows/${external.relativePath}`;
    const secondary = createProjectSettingsFixture('tools-library');
    secondary.relativePath = `Library/${secondary.fileName}`;
    secondary.absolutePath = `/managed/workflows/${secondary.relativePath}`;
    const omitted = createProjectSettingsFixture('omitted-dependencies');
    omitted.settings.status = 'published';
    omitted.settings.endpointName = 'omitted';
    const trackers = createProjectSettingsRouteTrackers();
    await installProjectSettingsRoutes(page, [root, helper, external, secondary, omitted], trackers);

    const capturedHelperRevision = 'active-dependency-id';
    const capturedExternalRevision = external.revisionId;
    helper.revisionId = capturedHelperRevision;
    let treeRevision = 0;
    await page.route('**/api/workflows/tree', (route) =>
      route.fulfill({
        json: {
          root: '/managed/workflows',
          sync: { epoch: 'reference-ui', revision: treeRevision },
          folders: [
            {
              id: 'Bundle',
              bundleId,
              name: 'Test bundle',
              relativePath: 'Bundle',
              absolutePath: '/managed/workflows/Bundle',
              updatedAt: savedAt,
              folders: [],
              projects: [root, helper],
            },
          ],
          projects: [external, secondary, omitted],
        },
      }),
    );
    await page.route('**/api/workflows/projects/reference-overview', (route) =>
      route.fulfill({
        json: {
          complete: false,
          bundles: [{ bundleId, count: 2, complete: true }],
          endpoints: [
            {
              projectId: root.projectMetadataId,
              coverage: 'complete',
              dependencies: [helper, external].map((project) => {
                const activeRevisionId = project === helper ? capturedHelperRevision : capturedExternalRevision;
                return {
                  projectId: project.projectMetadataId,
                  name: project.name,
                  relativePath: project.relativePath,
                  changed: project.revisionId !== activeRevisionId,
                  unavailable: false,
                  revisions: [{ selector: 'latest', activeRevisionId, savedRevisionId: project.revisionId }],
                };
              }),
            },
          ],
        },
      }),
    );
    const use = (source: WorkflowProjectItem, sourceGraphName: string, nodeTitle: string) => ({
      sourcePath: source.relativePath,
      sourceName: source.name,
      sourceGraphName,
      nodeTitle,
      selector: 'latest',
      savedAt,
    });
    await page.route('**/api/workflows/bundles/test-bundle-id/external-references', (route) =>
      route.fulfill({
        json: {
          complete: true,
          projects: [
            {
              projectId: external.projectMetadataId,
              name: external.name,
              relativePath: external.relativePath,
              uses: [use(helper, 'Main', 'Call shared'), use(root, 'Main', 'Load settings')],
            },
            {
              projectId: secondary.projectMetadataId,
              name: secondary.name,
              relativePath: secondary.relativePath,
              uses: [use(helper, 'Main', 'Call shared'), use(helper, 'Recovery', 'Call fallback')],
            },
          ],
        },
      }),
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await authenticateIfNeeded(page);
    await waitForDashboardReady(page);
    const folder = page.getByRole('button', { name: 'Expand Test bundle bundle', exact: true });
    const label = page.getByRole('button', { name: '2 external references', exact: true });
    await expect(label).toBeVisible();
    const rowBounds = await folder.boundingBox();
    const iconBounds = await folder.getByRole('img', { name: 'Bundle', exact: true }).boundingBox();
    const labelBounds = await label.boundingBox();
    expect(labelBounds!.x).toBeCloseTo(iconBounds!.x);
    expect(labelBounds!.y).toBeGreaterThanOrEqual(rowBounds!.y + rowBounds!.height);
    await label.click();
    const details = page.getByRole('dialog', { name: 'External references' });
    await expect(page.getByTestId('workflow-reference-details-modal--blanket')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0.56)',
    );
    await expect(details.getByRole('heading', { level: 3 })).toHaveText([helper.name, root.name]);
    const helperHeading = details.getByRole('heading', { name: helper.name, level: 3, exact: true });
    await expect(helperHeading).toHaveAttribute('title', /Source revision saved/);
    const helperGroup = helperHeading.locator('..');
    const mainSite = helperGroup.getByText('Main / Call shared', { exact: true }).locator('..');
    await expect(mainSite.getByRole('heading', { level: 4 })).toHaveText([external.name, secondary.name]);
    const fallbackSite = helperGroup.getByText('Recovery / Call fallback', { exact: true }).locator('..');
    await expect(fallbackSite.getByRole('heading', { level: 4 })).toHaveText(secondary.name);
    const rootGroup = details.getByRole('heading', { name: root.name, level: 3, exact: true }).locator('..');
    await expect(rootGroup.getByText('Main / Load settings', { exact: true })).toBeVisible();
    await expect(rootGroup.getByRole('heading', { level: 4 })).toHaveText(external.name);
    await expect(rootGroup).toHaveCSS('border-top-width', '1px');

    const target = mainSite.getByRole('heading', { name: external.name, exact: true }).locator('../..');
    const targetPath = target.getByText('Library/shared-library', { exact: true });
    const openTarget = target.getByRole('button', { name: 'Open project', exact: true });
    await expect(targetPath).toBeVisible();
    await expect(openTarget).toBeVisible();
    const pathBounds = (await targetPath.boundingBox())!;
    expect((await openTarget.boundingBox())!.y).toBeGreaterThanOrEqual(pathBounds.y + pathBounds.height);
    await openTarget.click();
    await expect(details).toHaveCount(0);
    await expect
      .poll(() => trackers.projectLoadRequests.map((request) => request.path))
      .toContain(external.absolutePath);

    await folder.click();
    const helperRow = page.locator('.project-row', { hasText: helper.name });
    const helperLabel = helperRow.locator('.label');
    const green = page.getByRole('img', { name: 'Used by a published endpoint' });
    await expect(green).toHaveCount(2);
    await expect(green.first()).toHaveCSS('border-top-color', 'rgb(126, 226, 148)');
    await expect(green.first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(helperLabel).toHaveCSS('color', 'rgb(126, 226, 148)');
    const rootRow = page.locator('.project-row', { hasText: root.name });
    await rootRow.dblclick();
    const active = page.locator('.active-project-section');
    await expect(active.getByText('Published', { exact: true })).toBeVisible();

    const reportSave = (absolutePath: string) => {
      treeRevision++;
      return page.evaluate((path) => {
        const editor = document.querySelector<HTMLIFrameElement>('.dashboard-editor-frame')!;
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'project-saved', path },
            origin: location.origin,
            source: editor.contentWindow,
          }),
        );
      }, absolutePath);
    };

    root.revisionId = 'saved-owner-id';
    root.settings.status = 'unpublished_changes';
    await reportSave(root.absolutePath);
    await expect(active.getByText('Unpublished changes', { exact: true })).toBeVisible();
    await expect(green).toHaveCount(2);

    // The root was republished before the next dependency save.
    root.settings.status = 'published';
    await Promise.all([
      page.waitForResponse((response) => isOwnerWebAppRead(response.url()), { timeout: 10_000 }),
      reportSave(root.absolutePath),
    ]);
    await expect(active.getByText('Published', { exact: true })).toBeVisible();
    const readsBeforeDependencySave = ownerWebAppReads;

    helper.revisionId = 'saved-dependency-id';
    await reportSave(helper.absolutePath);
    await expect(active.getByText('Unpublished changes', { exact: true })).toBeVisible();
    const yellow = helperRow.getByRole('img', { name: 'Changes affect a published endpoint' });
    await expect(yellow).toHaveCSS('border-top-color', 'rgb(255, 215, 106)');
    await expect(yellow).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(helperLabel).toHaveCSS('color', 'rgb(255, 215, 106)');
    await expect(page.locator('.project-row', { hasText: external.name }).locator(green)).toBeVisible();
    await expect(green).toHaveCount(1);
    expect(ownerWebAppReads).toBe(readsBeforeDependencySave);

    // Both tab changes refresh the catalog while the published references are still current.
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const helperTab = frame.locator('.projects-container .project', { hasText: helper.name });
    const initialRowTop = (await helperRow.boundingBox())!.y;
    const overviewUrl = '**/api/workflows/projects/reference-overview';
    const resume = Promise.withResolvers<void>();
    const holdOverview = async (route: Route) => {
      await resume.promise;
      await route.fallback();
    };
    await page.route(overviewUrl, holdOverview);
    try {
      for (const opening of [true, false]) {
        const requested = page.waitForRequest(overviewUrl, { timeout: 10_000 });
        if (opening) {
          await helperRow.dblclick();
          await expect(helperTab).toHaveClass(/\bactive\b/);
        } else {
          await helperTab.hover();
          await frame.getByRole('button', { name: `Close ${helper.name}`, exact: true }).click();
          await expect(helperTab).toHaveCount(0);
        }
        await requested;
        await expect(label).toBeVisible({ timeout: 3000 });
        await expect(yellow).toBeVisible();
        expect((await helperRow.boundingBox())!.y).toBeCloseTo(initialRowTop);
      }
    } finally {
      resume.resolve();
      await page.unroute(overviewUrl, holdOverview);
    }

    await active.getByRole('button', { name: 'Changed referenced projects (1)', exact: true }).click();
    const changed = page.getByRole('dialog', { name: 'Changed referenced projects' });
    const inBundleGroup = changed.getByRole('heading', { name: 'In this bundle', exact: true }).locator('..');
    const externalHeading = changed.getByRole('heading', { name: 'External references', exact: true });
    await expect(inBundleGroup.getByRole('heading', { level: 4 })).toHaveText(helper.name);
    await expect(inBundleGroup).toContainText('Bundle/bundle-helper');
    await expect(inBundleGroup).toContainText('Saved revision changed');
    await expect(inBundleGroup.locator('code[title="active-dependency-id"]')).toBeVisible();
    await expect(inBundleGroup.locator('code[title="saved-dependency-id"]')).toBeVisible();
    await expect(externalHeading).toHaveCount(0);

    external.revisionId = 'saved-external-id';
    await reportSave(external.absolutePath);
    await expect(externalHeading.locator('..').getByRole('heading', { level: 4 })).toHaveText(external.name);
    await expect(inBundleGroup.getByRole('heading', { level: 4 })).toHaveText(helper.name);
    await inBundleGroup.getByRole('button', { name: 'Open project', exact: true }).click();
    await expect(changed).toHaveCount(0);
    await expect.poll(() => trackers.projectLoadRequests.map((request) => request.path)).toContain(helper.absolutePath);

    await page.locator('.project-row', { hasText: omitted.name }).click();
    await expect(active.getByText('Dependencies unverified', { exact: true })).toBeVisible();
  });

  test('history preview uses the normal tree for all captured projects and opens the frozen Subgraph', async ({
    page,
  }) => {
    const root = createProjectSettingsFixture('History root');
    root.settings.status = 'published';
    root.settings.endpointName = 'history-root';
    const unrelated = createProjectSettingsFixture('Unrelated draft');
    await installProjectSettingsRoutes(page, [root, unrelated], createProjectSettingsRouteTrackers());
    const registry = createBuiltInRegistry();
    const subgraph = registry.createDynamic('subGraph');
    subgraph.id = 'historical-target-node' as typeof subgraph.id;
    subgraph.title = 'Historical target';
    subgraph.visualData = { x: 150, y: 200, width: 240 };
    subgraph.data = { targetProjectId: 'historical-external', graphId: 'frozen-child', targetVersion: 'latest' };
    const output = registry.createDynamic('graphOutput');
    output.id = 'historical-output' as typeof output.id;
    output.data.id = 'frozen-result';
    output.visualData = { x: 150, y: 200, width: 220 };
    const rootProject: Project = {
      metadata: { id: root.id as ProjectId, title: root.name, description: '', mainGraphId: 'frozen-root' as GraphId },
      graphs: {
        ['frozen-root' as GraphId]: {
          metadata: { id: 'frozen-root' as GraphId, name: 'Frozen root' },
          connections: [],
          nodes: [subgraph],
        },
      },
    };
    const child: Project = {
      metadata: {
        id: 'historical-external' as ProjectId,
        title: 'Frozen helper',
        description: '',
        mainGraphId: 'frozen-child' as GraphId,
      },
      graphs: {
        ['frozen-child' as GraphId]: {
          metadata: { id: 'frozen-child' as GraphId, name: 'Frozen child graph' },
          connections: [],
          nodes: [output],
        },
      },
    };
    const bundleMemberCall = registry.createDynamic('subGraph');
    bundleMemberCall.id = 'historical-bundle-call' as typeof bundleMemberCall.id;
    bundleMemberCall.visualData = { x: 150, y: 400, width: 240 };
    bundleMemberCall.data = {
      targetProjectId: 'historical-bundle-member',
      graphId: 'frozen-child',
      targetVersion: 'latest',
    };
    const publishedCall = registry.createDynamic('subGraph');
    publishedCall.id = 'historical-published-call' as typeof publishedCall.id;
    publishedCall.visualData = { x: 460, y: 200, width: 240 };
    publishedCall.data = { targetProjectId: child.metadata.id, graphId: 'frozen-child', targetVersion: 'published' };
    rootProject.graphs['frozen-root' as GraphId]!.nodes.push(bundleMemberCall, publishedCall);
    const childGraphId = 'frozen-child' as GraphId;
    const childGraph = child.graphs[childGraphId]!;
    const publishedChild: Project = {
      ...child,
      graphs: { [childGraphId]: { ...childGraph, metadata: { ...childGraph.metadata!, name: 'Published child graph' } } },
    };
    const member: Project = {
      ...child,
      metadata: { ...child.metadata, id: 'historical-bundle-member' as ProjectId, title: 'Frozen bundle member' },
    };
    const savedAt = '2026-10-20T12:00:00.000Z';
    const history = {
      rootArtifactId: 'root-artifact',
      endpointName: 'history-root',
      coverage: 'frozen',
      publishedAt: savedAt,
      projects: [
        {
          artifactId: 'root-artifact',
          projectId: root.id,
          relativePath: 'Bundle/Nested/Root.rivet-project',
          bundleRelativePath: 'Bundle',
          name: root.name,
          savedAt,
        },
        {
          artifactId: 'member-artifact',
          projectId: member.metadata.id,
          relativePath: 'Bundle/Nested/Member.rivet-project',
          bundleRelativePath: 'Bundle',
          name: member.metadata.title,
          savedAt,
        },
        {
          artifactId: 'child-artifact',
          projectId: child.metadata.id,
          relativePath: 'Shared/Helper.rivet-project',
          name: child.metadata.title,
          savedAt,
        },
        {
          artifactId: 'published-child-artifact',
          projectId: child.metadata.id,
          relativePath: 'Shared/Helper.rivet-project',
          name: child.metadata.title,
          savedAt,
        },
      ],
      references: ([
        [subgraph, 'child-artifact', 'latest'],
        [bundleMemberCall, 'member-artifact', 'latest'],
        [publishedCall, 'published-child-artifact', 'published'],
      ] as const).map(([call, targetArtifactId, selector]) => ({
        sourceArtifactId: 'root-artifact',
        sourceGraphId: 'frozen-root',
        nodeId: call.id,
        targetArtifactId,
        targetGraphId: 'frozen-child',
        selector,
      })),
    };
    const artifacts = new Map([
      ['root-artifact', rootProject],
      ['member-artifact', member],
      ['child-artifact', child],
      ['published-child-artifact', publishedChild],
    ]);
    await page.route('**/api/workflows/projects/published-versions/preview-tree', (route) =>
      route.fulfill({ json: history }),
    );
    await page.route('**/api/workflows/projects/published-versions/preview', (route) => {
      const { artifactId } = route.request().postDataJSON();
      return route.fulfill({
        json: {
          contents: serializeProject(artifacts.get(artifactId)!),
          datasetsContents: null,
        },
      });
    });
    let liveReads = 0;
    await page.route('**/api/workflows/subgraph-projects/**', (route) => {
      liveReads++;
      return route.fulfill({ status: 403, json: { error: 'Live lookup is outside the captured revision.' } });
    });
    const { modal } = await openProjectSettingsModal(page, root);
    const startPreview = async () => {
      await modal.getByRole('tab', { name: 'Published revision history' }).click();
      await modal.getByRole('button', { name: 'Preview' }).first().click();
    };
    const preview = page.getByRole('region', { name: 'History preview' });
    const bundleRow = preview.getByRole('button', { name: 'Collapse Bundle bundle', exact: true });
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const caller = frame.locator('.node[data-nodeid="historical-target-node"]');
    const activeTabTitle = frame.locator('.projects-container .project.active .project-name');
    const memberRow = preview.getByRole('button', { name: 'Frozen bundle member', exact: true });

    await expectHistoryReadCancelled(page, 'preview', startPreview, async () => {
      await memberRow.click();
      await expect(memberRow).toHaveAttribute('aria-current', 'true');
      await expect(frame.locator('.node[data-nodeid="historical-output"]')).toBeVisible();
      await expect(activeTabTitle).toHaveText('Frozen bundle member (history preview)');
    });
    await expect(bundleRow).toHaveClass('folder-row');
    await expect(bundleRow.getByRole('img', { name: 'Bundle', exact: true })).toBeVisible();
    await expect(bundleRow.getByLabel('2 projects in Bundle')).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Collapse Nested', exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Collapse Shared', exact: true })).toBeVisible();
    await expect(page.locator('.active-project-slot')).toHaveCount(0);
    await expect(page.locator('.project-row', { hasText: unrelated.name })).toHaveCount(0);

    await expect(memberRow).toContainClass('project-row');
    await bundleRow.press('Enter');
    await expect(memberRow).toHaveCount(0);
    await preview.getByRole('button', { name: 'Expand Bundle bundle', exact: true }).press('Space');
    const rootRow = preview.getByRole('button', { name: 'History root Endpoint', exact: true });
    await rootRow.click();
    await expect(caller.getByText('Frozen child graph')).toBeVisible();
    await expect(frame.locator('.node[data-nodeid="historical-published-call"]').getByText('Published child graph')).toBeVisible();
    await expect(activeTabTitle).toHaveText(`${root.name} (history preview)`);
    await expect(caller.locator('.subgraph-target-path-separator')).toBeVisible();
    await expect(frame.getByText('Read-only graph', { exact: true })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Back to Current' })).toHaveCount(0);
    await expect(frame.locator('.read-only-border')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Run project', exact: true })).toHaveCount(0);
    await expect(caller.getByText('frozen-result', { exact: true })).toBeVisible();
    await caller.getByRole('button', { name: 'Go to subgraph', exact: true }).click();
    await expect(frame.locator('.node[data-nodeid="historical-output"]')).toBeVisible();
    await page.keyboard.press('PageUp');
    await expect(caller.getByText('frozen-result', { exact: true })).toBeVisible();
    await expect(rootRow).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('PageDown');
    await expect(frame.locator('.node[data-nodeid="historical-output"]')).toBeVisible();
    await expect(preview.getByRole('button', { name: /^Frozen helper Saved latest/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(liveReads).toBe(0);
    await preview.getByRole('button', { name: 'Exit history preview' }).click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator('.project-row', { hasText: unrelated.name })).toBeVisible();
    await expect(caller).toHaveCount(0);

    // A live selection supersedes the history request even before its tree has loaded.
    const liveRow = page.locator('.project-row', { hasText: unrelated.name });
    await showProjectSettingsModal(page, root);
    await expectHistoryReadCancelled(page, 'preview-tree', startPreview, async () => {
      await liveRow.click();
      await expect(page.locator('.active-project-name')).toHaveText(unrelated.name);
    });
    await expect(preview).toHaveCount(0);

    // Exiting while a frozen project is loading must preserve live tab selection.
    await liveRow.dblclick();
    await expect(page.locator('.active-project-name')).toHaveText(unrelated.name);
    await showProjectSettingsModal(page, root);
    await expectHistoryReadCancelled(page, 'preview', startPreview, () =>
      preview.getByRole('button', { name: 'Exit history preview' }).click(),
    );
    await expect(preview).toHaveCount(0);
    await expect(caller).toHaveCount(0);
    await frame.locator('.projects-container .project', { hasText: unrelated.name }).locator('.project-name').click();
    await expect(page.locator('.active-project-name')).toHaveText(unrelated.name);
  });

  test('legacy history preview shows a missing Subgraph target without revealing IDs or reading the live project', async ({
    page,
  }) => {
    const owner = createProjectSettingsFixture('Legacy history owner');
    owner.settings.status = 'published';
    owner.settings.endpointName = 'legacy-history';
    const liveTarget = createProjectSettingsFixture('Live dependency');
    await installProjectSettingsRoutes(page, [owner, liveTarget], createProjectSettingsRouteTrackers());

    const registry = createBuiltInRegistry();
    const output = registry.createDynamic('graphOutput');
    output.data.id = 'saved-port';
    const unavailableGraphId = 'uncaptured-target-graph-id' as GraphId;
    const target: Project = {
      metadata: { id: liveTarget.id as ProjectId, title: liveTarget.name, description: '' },
      graphs: {
        [unavailableGraphId]: {
          metadata: { id: unavailableGraphId, name: 'Uncaptured graph' },
          connections: [],
          nodes: [output],
        },
      },
    };
    const call = registry.createDynamic('subGraph');
    call.id = 'legacy-history-call' as typeof call.id;
    call.title = 'Legacy reference';
    call.visualData = { x: 150, y: 200, width: 240 };
    call.data = {
      targetProjectId: target.metadata.id,
      targetVersion: 'latest',
      graphId: unavailableGraphId,
      targetBoundary: getGraphBoundary(target, unavailableGraphId),
    };
    const savedGraph = 'legacy-history-main' as GraphId;
    const project: Project = {
      metadata: { id: owner.id as ProjectId, title: owner.name, description: '', mainGraphId: savedGraph },
      graphs: {
        [savedGraph]: { metadata: { id: savedGraph, name: 'Main' }, connections: [], nodes: [call] },
      },
    };
    const savedAt = '2026-10-20T12:00:00.000Z';
    await page.route('**/api/workflows/projects/published-versions/preview-tree', (route) =>
      route.fulfill({
        json: {
          rootArtifactId: 'legacy-artifact',
          endpointName: 'legacy-history',
          coverage: 'project-only',
          publishedAt: savedAt,
          projects: [
            {
              artifactId: 'legacy-artifact',
              projectId: owner.id,
              relativePath: owner.relativePath,
              name: owner.name,
              savedAt,
            },
          ],
          references: [],
        },
      }),
    );
    await page.route('**/api/workflows/projects/published-versions/preview', (route) =>
      route.fulfill({ json: { contents: serializeProject(project), datasetsContents: null } }),
    );
    let liveReads = 0;
    await page.route('**/api/workflows/subgraph-projects/**', (route) => {
      liveReads++;
      return route.fulfill({ status: 403, json: { error: 'History cannot load a live target.' } });
    });

    const { modal } = await openProjectSettingsModal(page, owner);
    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    await modal.getByRole('button', { name: 'Preview' }).first().click();
    const preview = page.getByRole('region', { name: 'History preview' });
    await expect(preview.getByText('Dependencies weren’t saved with this revision.')).toBeVisible();
    await expect(preview.getByRole('button', { name: liveTarget.name })).toHaveCount(0);
    const frame = page.frameLocator('iframe.dashboard-editor-frame');
    const node = frame.locator('.node[data-nodeid="legacy-history-call"]');
    await expect(node.getByText('Target unavailable in this revision', { exact: true })).toBeVisible();
    await expect(node.getByText('saved-port', { exact: true })).toBeVisible();
    await expect(node.getByText(liveTarget.id)).toHaveCount(0);
    await expect(node.getByText(unavailableGraphId)).toHaveCount(0);
    expect(liveReads).toBe(0);
  });

  test('published revision history paginates, stars, previews, and restores versions', async ({ page }) => {
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
    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    const historyModal = modal.getByRole('tabpanel', { name: 'Published revision history' });
    await expect(historyModal).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(historyModal).toContainText(endpointName);
    await expect(historyModal).toContainText('Current');
    await expect(historyModal.getByRole('listitem')).toHaveCount(10);
    const firstPublishedDate = historyModal.locator('.published-version-history-date').first();
    await expect(firstPublishedDate).toHaveText(/^\d{1,2} Apr 2026, \d{2}:\d{2}:\d{2}$/);
    await expect(firstPublishedDate).toHaveAttribute('title', '2026-04-08T10:30:00.000Z');
    await expect(historyModal.getByRole('button', { name: 'Preview' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Restore' })).toHaveCount(10);
    await expect(historyModal.getByRole('button', { name: 'Star published version' })).toHaveCount(10);
    const addFirstCommentButton = historyModal.getByRole('button', {
      name: 'Add comment for published version published-version-1',
      exact: true,
    });
    await expect(addFirstCommentButton).toBeVisible();
    await expect(
      historyModal.getByRole('textbox', {
        name: 'Comment for published version published-version-1',
        exact: true,
      }),
    ).toHaveCount(0);
    await historyModal.getByRole('button', { name: 'Star published version' }).first().click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    expect(routeTrackers.publishedVersionStarRequests).toEqual([
      {
        relativePath: project.relativePath,
        versionId: 'published-version-1',
        isStarred: true,
      },
    ]);
    await addFirstCommentButton.click();
    const firstCommentInput = historyModal.getByRole('textbox', {
      name: 'Comment for published version published-version-1',
      exact: true,
    });
    await expect(firstCommentInput).toBeFocused();
    await firstCommentInput.fill('Launch baseline');
    await firstCommentInput.press('Enter');
    await expect.poll(() => routeTrackers.publishedVersionCommentRequests.length).toBe(1);
    expect(routeTrackers.publishedVersionCommentRequests).toEqual([
      {
        relativePath: project.relativePath,
        versionId: 'published-version-1',
        comment: 'Launch baseline',
      },
    ]);
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
    await modal.getByRole('tab', { name: 'Endpoint' }).click();
    await expect(historyModal).toHaveCount(0);
    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    await expect(historyModal.getByRole('button', { name: 'Unstar published version' })).toHaveCount(1);
    await expect(
      historyModal.getByRole('button', {
        name: 'Edit comment for published version published-version-1',
        exact: true,
      }),
    ).toHaveText('Launch baseline');
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
    expect(routeTrackers.publishedVersionPreviewRequests[0]).toMatchObject({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(page.locator('.dashboard-empty-state')).toBeHidden();
    await expect(page.locator('.Toastify__toast', { hasText: 'Failed to open project' })).toHaveCount(0);
    await expect(modal).toHaveCount(0);

    const previewPanel = page.getByRole('region', { name: 'History preview' });
    await expect(previewPanel).toBeVisible();
    await expect(previewPanel.locator('.project-row', { hasText: project.name })).toHaveAttribute('aria-current', 'true');
    await expect(projectRow).toHaveCount(1);
    await previewPanel.getByRole('button', { name: 'Exit history preview' }).click();
    await expect(previewPanel).toHaveCount(0);
    await projectRow.click();
    await projectRow.dblclick();
    await expect.poll(() => routeTrackers.projectLoadRequests.length).toBe(1);
    expect(routeTrackers.projectLoadRequests[0]).toEqual({
      path: project.absolutePath,
    });
    await page.locator('.active-project-more-button').click();
    await expect(modal).toBeVisible();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible({ timeout: 30_000 });

    await modal.getByRole('tab', { name: 'Published revision history' }).click();
    await expect(historyModal).toBeVisible();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Drafts stay in the project tree');
      await dialog.accept();
    });
    await historyModal.getByRole('button', { name: 'Restore' }).first().click();
    await expect.poll(() => routeTrackers.publishedVersionRestoreRequests.length).toBe(1);
    expect(routeTrackers.publishedVersionRestoreRequests[0]).toMatchObject({
      relativePath: project.relativePath,
      versionId: 'published-version-1',
    });
    await expect(historyModal.getByRole('listitem').first()).toContainText(endpointName);
    await expect(historyModal.getByRole('listitem').first()).toContainText('Current');
    await expect(historyModal.getByText('Page 1 of 2')).toBeVisible();
    expect(routeTrackers.projectLoadRequests).toHaveLength(1);
    await modal.getByRole('tab', { name: 'Endpoint' }).click();
    await expect(modal.locator('.project-status-badge.published')).toBeVisible();
    await modal.getByRole('button', { name: 'Close project settings' }).click();
    await expect(modal).toHaveCount(0);
  });
});
