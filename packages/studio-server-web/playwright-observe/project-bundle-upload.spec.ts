// test-style: fixture-read: creates and reads only owned bundle upload fixtures.
import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectProjectBundle } from '../../studio-server-api/src/routes/workflows/project-bundle';
import { prepareProjectBundleImport } from '../../studio-server-api/src/routes/workflows/project-bundle-import';
import { projectBundleFixture } from '../../studio-server-api/src/tests/helpers/project-bundle-fixture';
import { authenticateIfNeeded, mockHostedEditorBootstrap, waitForDashboardReady } from './helpers/hostedEditorObserve';
import type { WorkflowFolderItem, WorkflowProjectItem } from '../dashboard/types';
import { expectStudioModalSizing } from './helpers/modalSizing';

for (const kind of ['archive', 'folder'] as const)
  test(`Upload bundle imports ${kind === 'archive' ? 'an archive' : 'a folder'} into its own expandable folder`, async ({
    page,
  }) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-browser-bundle-upload-'));
    const directory = path.join(temporary, 'portable');
    const files: { path: string; contents: string }[] = [];
    const fixture = projectBundleFixture();
    await collectProjectBundle({
      source: {
        ...fixture.source,
        versionPolicy: 'latest',
        workspace: {
          name: 'Edited feature',
          folders: ['Empty'],
          members: [fixture.root.project, fixture.child.project].map((project) => ({
            projectId: project.metadata.id,
            relativePath: `${project.metadata.id}.rivet-project`,
          })),
        },
      },
      rootVersion: 'latest',
      signal: new AbortController().signal,
      progress: () => {},
      writeFile: async (file, contents) => {
        files.push({ path: file, contents });
        const output = path.join(directory, file);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, contents);
      },
    });
    const parent: WorkflowFolderItem = {
      id: 'Imports',
      name: 'Imports',
      relativePath: 'Imports',
      absolutePath: '/workflows/Imports',
      updatedAt: '',
      folders: [],
      projects: [],
    };
    let imports = 0;
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/workflows/tree')
          return route.fulfill({
            json: { root: '/workflows', capabilities: { explicitBundles: true }, folders: [parent], projects: [] },
          });
        if (url.pathname === '/api/workflows/project-bundles/import') {
          imports++;
          expect(route.request().headers()['x-rivet-bundle-intent']).toBe('1');
          const body = route.request().postDataJSON();
          expect(body.folderRelativePath).toBe('Imports');
          const prepared = prepareProjectBundleImport(body.files);
          expect(prepared.folders).toEqual(['Empty']);
          if (kind === 'archive' && imports === 1)
            return route.fulfill({ status: 503, json: { error: 'Fixture storage unavailable' } });
          const relativePath = `Imports/${prepared.folderName}`;
          const projects = prepared.projects.map<WorkflowProjectItem>((p) => ({
            id: `${relativePath}/${p.name}.rivet-project`,
            projectMetadataId: p.id,
            bundleId: prepared.rootProjectId,
            name: p.name,
            fileName: `${p.name}.rivet-project`,
            relativePath: `${relativePath}/${p.name}.rivet-project`,
            absolutePath: `/workflows/${relativePath}/${p.name}.rivet-project`,
            updatedAt: '',
            settings: {
              status: 'unpublished',
              publicationVersion: '0',
              endpointName: '',
              lastPublishedAt: null,
              publishedWebApps: [],
            },
          }));
          const folder = {
            id: relativePath,
            bundleId: prepared.rootProjectId,
            name: prepared.folderName,
            relativePath,
            absolutePath: `/workflows/${relativePath}`,
            updatedAt: '',
            folders: [],
            projects,
          };
          parent.folders.push(folder);
          return route.fulfill({ status: 201, json: { folder, projects, rootProjectId: prepared.rootProjectId } });
        }
        if (url.pathname.includes('local-upgrade'))
          return route.fulfill({ json: { available: false, eligible: false } });
        return route.fulfill({ status: 503, json: { error: 'Unknown fixture API route' } });
      },
    );
    await mockHostedEditorBootstrap(page);
    try {
      await page.goto('/');
      await authenticateIfNeeded(page);
      await waitForDashboardReady(page);
      await page.getByRole('button', { name: 'Expand Imports', exact: true }).click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Upload project', exact: true })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Download bundle', exact: true })).toHaveCount(0);
      const action = page.getByRole('menuitem', { name: 'Upload bundle', exact: true });
      await expect(action.locator('svg path').nth(0)).toHaveAttribute('d', 'M7 16V3m-4 4 4-4 4 4');
      await expect(action.locator('svg path').nth(1)).toHaveAttribute('d', 'M17 19V6m-4 4 4-4 4 4');
      await action.click();
      const modal = page.getByRole('dialog', { name: 'Upload bundle' });
      await expectStudioModalSizing(modal);
      await expect(page.getByTestId('workflow-bundle-upload-modal')).toHaveCSS('background-color', 'rgb(31, 31, 34)');
      await expect(page.getByTestId('workflow-bundle-upload-modal--body')).toHaveCSS('padding', '0px');
      await expect(modal.locator('.workflow-project-bundle-footer')).toHaveCSS('gap', '12px');
      await page.screenshot({ path: test.info().outputPath(`bundle-upload-${kind}.png`) });
      await expect(modal.getByRole('button', { name: 'Choose bundle folder' })).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Choose bundle archive' })).toBeVisible();
      if (kind === 'archive') {
        await modal
          .getByLabel('Bundle archive')
          .setInputFiles({ name: 'bad.zip', mimeType: 'application/zip', buffer: Buffer.from('not a bundle') });
        await expect(modal.getByRole('alert')).toBeVisible();
        expect(imports).toBe(0);
        const zip = zipSync(Object.fromEntries(files.map((f) => [f.path, strToU8(f.contents)])));
        const archive = { name: 'portable.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) };
        await modal.getByLabel('Bundle archive').setInputFiles(archive);
        await expect(modal.getByRole('alert')).toContainText('Fixture storage unavailable');
        await expect(modal.getByRole('button', { name: 'Choose bundle archive' })).toBeEnabled();
        await expect(page.locator('.project-row').filter({ hasText: 'Root' })).toHaveCount(0);
        // Manual reselection of the same file must work; there is no automatic retry.
        await modal.getByLabel('Bundle archive').setInputFiles(archive);
      } else {
        await modal.getByLabel('Bundle folder').setInputFiles(directory);
      }
      await expect(modal).toHaveCount(0);
      await expect(page.locator('.project-row').filter({ hasText: 'Root' })).toBeVisible();
      await expect(page.locator('.project-row').filter({ hasText: '子供' })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Collapse Edited feature .* bundle$/ })).toBeVisible();
      expect(imports).toBe(kind === 'archive' ? 2 : 1);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });
