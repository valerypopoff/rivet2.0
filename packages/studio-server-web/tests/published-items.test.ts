import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostedRouteConfig, WorkflowProjectItem } from '../dashboard/types';
import { getPublishedItems, getPublishedRouteLabel } from '../dashboard/publishedItems';
import {
  buildWorkflowPublicationReferences,
  getWorkflowProjectContribution,
  getWorkflowProjectEndpointStatus,
  getWorkflowProjectPublicationStatus,
  getWorkflowProjectSummaryStatus,
} from '../dashboard/workflowProjectPublicationStatus';

const routeConfig: HostedRouteConfig = {
  executorWsUrl: '',
  remoteDebuggerDefaultWs: '',
  publishedWorkflowsBasePath: '/workflows/',
  latestWorkflowsBasePath: '/workflows-latest',
  internalPublishedWorkflowsBaseUrl: 'http://execution.test:8181/internal/workflows',
  publishedAppsBasePath: '/apps/',
  latestAppsBasePath: '/apps-latest',
  webAppsAuthMode: 'none',
};

void test('summary text separates saved local changes from distinct changed referenced projects', () => {
  for (const [ownStatus, count, expectedText, expectedReferences] of [
    ['published', 0, 'Published', null],
    ['unpublished_changes', 0, 'Unpublished changes', null],
    ['published', 1, 'Unpublished changes', '1 referenced project'],
    ['published', 3, 'Unpublished changes', '3 referenced projects'],
    ['unpublished_changes', 1, 'Unpublished changes here and', '1 referenced project'],
    ['unpublished_changes', 3, 'Unpublished changes here and', '3 referenced projects'],
  ] as const) {
    const owner = project('owner', 'Owner', {
      status: ownStatus,
      endpointName: 'owner',
      lastPublishedAt: null,
      publishedWebApps: [],
    });
    const references = buildWorkflowPublicationReferences([owner], null, false);
    const dependencies = Array.from({ length: count }, (_, index) => ({
      projectId: `dependency-${index}`,
      name: `Dependency ${index}`,
      relativePath: null,
      changed: true,
      unavailable: false,
    }));
    // Multiple call sites must not inflate the displayed project count.
    references.changedByCaller.set('owner', [...dependencies, ...dependencies]);
    const summary = getWorkflowProjectSummaryStatus(owner, references);
    assert.equal(summary.text, expectedText);
    assert.equal(summary.referenceText, expectedReferences);
    assert.equal(summary.tone, ownStatus === 'published' && count === 0 ? 'published' : 'unpublished_changes');
    assert.equal(owner.settings.status, ownStatus);
  }
});

void test('summary preserves contribution-only, dual-status, and unpublished project states', () => {
  const owner = project('owner', 'Owner', {
    status: 'unpublished',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [],
  });
  const references = buildWorkflowPublicationReferences([owner], null, false);
  assert.equal(getWorkflowProjectSummaryStatus(owner, references).text, 'Unpublished');
  for (const marker of ['published', 'changed'] as const) {
    references.markerByProject.set('owner', marker);
    const summary = getWorkflowProjectSummaryStatus(owner, references);
    assert.equal(
      summary.text,
      marker === 'published' ? 'Contributes to published' : 'Contributes to unpublished changes',
    );
    assert.equal(summary.contributionOnly, true);
    assert.equal(summary.secondaryContribution, null);
  }
  owner.settings.status = 'published';
  const dual = getWorkflowProjectSummaryStatus(owner, references);
  assert.equal(dual.text, 'Published');
  assert.equal(dual.contributionOnly, false);
  assert.equal(dual.secondaryContribution?.label, 'Contributes to unpublished changes');
});

void test('summary includes owned web-app changes and does not call missing dependencies confirmed edits', () => {
  const owner = project('owner', 'Owner', {
    status: 'published',
    publicationStatus: 'unpublished_changes',
    endpointName: 'owner',
    lastPublishedAt: null,
    publishedWebApps: [],
  });
  const references = buildWorkflowPublicationReferences([owner], null, false);
  const missing = { projectId: 'missing', name: 'Missing', relativePath: null, changed: true, unavailable: true };
  references.changedByCaller.set('owner', [missing, missing]);
  const local = getWorkflowProjectSummaryStatus(owner, references);
  assert.equal(local.text, 'Unpublished changes');
  assert.equal(local.referenceText, null);
  assert.equal(local.notice, '1 referenced project is unavailable');
  delete owner.settings.publicationStatus;
  const unavailable = getWorkflowProjectSummaryStatus(owner, references);
  assert.equal(unavailable.text, 'Referenced project unavailable');
  assert.equal(unavailable.tone, 'unpublished_changes');
  references.changedByCaller.clear();
  references.unverifiedByCaller.add('owner');
  assert.equal(getWorkflowProjectSummaryStatus(owner, references).notice, 'Dependencies unverified');
  references.canCaptureRelease.add('owner');
  assert.equal(getWorkflowProjectSummaryStatus(owner, references).notice, 'Update this endpoint to track dependencies');
});

void test('endpoint status text can retain its own publication scope independently of web apps', () => {
  const owner = project('owner', 'Owner', {
    status: 'unpublished',
    publicationStatus: 'published',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [],
  });
  assert.equal(getWorkflowProjectSummaryStatus(owner).text, 'Published');
  assert.equal(getWorkflowProjectSummaryStatus(owner, null, owner.settings.status).text, 'Unpublished');
  owner.settings.status = 'published';
  owner.settings.publicationStatus = 'unpublished_changes';
  const references = buildWorkflowPublicationReferences([owner], null, false);
  references.changedByCaller.set('owner', [
    {
      projectId: 'dependency',
      name: 'Dependency',
      relativePath: null,
      changed: true,
      unavailable: false,
    },
  ]);
  assert.equal(getWorkflowProjectSummaryStatus(owner, references).text, 'Unpublished changes here and');
  assert.equal(getWorkflowProjectSummaryStatus(owner, references, owner.settings.status).text, 'Unpublished changes');
});

void test('published route labels shorten only same-origin routes and preserve encoded paths', () => {
  for (const [route, label] of [
    ['/custom/workflows/test', 'custom/workflows/test'],
    ['/apps/a%20b?mode=view#result', 'apps/a%20b?mode=view#result'],
    ['https://rivet.test/apps/test', 'apps/test'],
    ['http://api/internal/workflows/test', 'http://api/internal/workflows/test'],
    ['//other.test/apps/test', 'https://other.test/apps/test'],
    ['http://[', 'http://['],
  ])
    assert.equal(getPublishedRouteLabel(route!, 'https://rivet.test'), label);
});

function project(id: string, name: string, settings: WorkflowProjectItem['settings']): WorkflowProjectItem {
  return {
    id,
    name,
    fileName: `${name}.rivet-project`,
    relativePath: `${name}.rivet-project`,
    absolutePath: `/workflows/${name}.rivet-project`,
    updatedAt: '2026-09-16T00:00:00.000Z',
    settings,
  };
}

void test('projects share saved dependency status without changing their catalog records or web app status', () => {
  const caller = {
    ...project('caller-path', 'Caller', {
      status: 'published',
      publicationStatus: 'published',
      endpointName: 'caller',
      lastPublishedAt: null,
      publishedWebApps: [
        { uiGraphId: 'app', uiGraphName: 'Console', slug: 'console', publishedAt: '', allowedEmails: [] },
      ],
    }),
    projectMetadataId: 'caller-id',
  };
  const peer = project('peer', 'Peer', {
    status: 'unpublished_changes',
    endpointName: 'peer',
    lastPublishedAt: null,
    publishedWebApps: [],
  });
  const dependency = { projectId: 'shared', name: 'Shared', relativePath: 'shared.rivet-project', unavailable: false };
  const overview = {
    complete: true,
    bundles: [],
    endpoints: [
      {
        projectId: 'caller-id',
        coverage: 'complete' as const,
        dependencies: [{ ...dependency, changed: true }],
      },
      {
        projectId: 'peer',
        coverage: 'complete' as const,
        dependencies: [
          { ...dependency, changed: false },
          { ...dependency, projectId: 'unchanged', changed: false },
        ],
      },
    ],
  };
  const projects = [caller, peer];
  const references = buildWorkflowPublicationReferences(projects, overview, false);

  assert.equal(getWorkflowProjectEndpointStatus(caller, references), 'unpublished_changes');
  assert.equal(getWorkflowProjectPublicationStatus(caller, references), 'unpublished_changes');
  assert.equal(references.markerByProject.get('shared'), 'changed');
  assert.equal(references.markerByProject.get('unchanged'), 'published');
  const shared = { ...peer, projectMetadataId: 'shared' };
  assert.deepEqual(getWorkflowProjectContribution(shared, references), {
    status: 'changed',
    label: 'Contributes to unpublished changes',
  });
  assert.equal(getWorkflowProjectPublicationStatus(shared, references), 'unpublished_changes');
  assert.deepEqual(getWorkflowProjectContribution({ ...shared, projectMetadataId: 'unchanged' }, references), {
    status: 'published',
    label: 'Contributes to published',
  });
  assert.equal(getWorkflowProjectContribution(caller, references), null);
  assert.equal(getWorkflowProjectContribution(shared, null), null);
  assert.deepEqual(
    getPublishedItems([caller], routeConfig, references).map((item) => [item.kind, item.status]),
    [
      ['endpoint', 'unpublished_changes'],
      ['web-app', 'published'],
    ],
  );
  assert.equal(caller.settings.status, 'published');
});

void test('lists every published endpoint and web app with its owning project and route', () => {
  const endpointAndApp = project('alpha', 'Alpha', {
    status: 'unpublished_changes',
    publicationStatus: 'unpublished_changes',
    endpointName: 'alpha endpoint',
    lastPublishedAt: '2026-09-15T00:00:00.000Z',
    publishedWebApps: [
      {
        uiGraphId: 'alpha-app',
        uiGraphName: 'Alpha console',
        slug: 'alpha-app',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
        status: 'published',
      },
    ],
  });
  const appOnly = project('beta', 'Beta', {
    status: 'unpublished',
    publicationStatus: 'published',
    endpointName: 'unpublished-endpoint-draft',
    lastPublishedAt: null,
    publishedWebApps: [
      {
        uiGraphId: 'beta-app',
        uiGraphName: 'Beta portal',
        slug: 'beta portal',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
        status: 'unpublished_changes',
      },
    ],
  });

  const items = getPublishedItems([appOnly, endpointAndApp], routeConfig);

  assert.deepEqual(
    items.map((item) => ({
      kind: item.kind,
      label: item.label,
      project: item.project.name,
      route: item.route,
      status: item.status,
    })),
    [
      {
        kind: 'endpoint',
        label: 'alpha endpoint',
        project: 'Alpha',
        route: '/workflows/alpha%20endpoint',
        status: 'unpublished_changes',
      },
      {
        kind: 'web-app',
        label: 'Alpha console',
        project: 'Alpha',
        route: '/apps/alpha-app',
        status: 'published',
      },
      {
        kind: 'web-app',
        label: 'Beta portal',
        project: 'Beta',
        route: '/apps/beta%20portal',
        status: 'unpublished_changes',
      },
    ],
  );
});

void test('omits unpublished endpoint drafts and projects without publications', () => {
  const unpublished = project('draft', 'Draft', {
    status: 'unpublished',
    publicationStatus: 'unpublished',
    endpointName: 'draft-endpoint',
    lastPublishedAt: null,
    publishedWebApps: [],
  });

  assert.deepEqual(getPublishedItems([unpublished], routeConfig), []);
});

void test('aggregate fallback preserves web-app freshness without changing endpoint status', () => {
  for (const status of ['published', 'unpublished_changes', undefined] as const) {
    const appOnly = project('app-only', 'App only', {
      status: 'unpublished',
      endpointName: 'draft',
      lastPublishedAt: null,
      publishedWebApps: [
        {
          uiGraphId: 'app',
          uiGraphName: 'App',
          slug: 'app',
          publishedAt: '2026-09-15T00:00:00.000Z',
          allowedEmails: [],
          status,
        },
      ],
    });
    assert.equal(getWorkflowProjectPublicationStatus(appOnly), status ?? 'published');
    assert.equal(appOnly.settings.status, 'unpublished');
    assert.deepEqual(
      getPublishedItems([appOnly], routeConfig).map((item) => item.kind),
      ['web-app'],
    );
  }
});

void test('treats a published web app from an older tree response as published', () => {
  const legacyTreeProject = project('legacy', 'Legacy', {
    status: 'unpublished',
    endpointName: '',
    lastPublishedAt: null,
    publishedWebApps: [
      {
        uiGraphId: 'legacy-app',
        uiGraphName: 'Legacy app',
        slug: 'legacy-app',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
      },
    ],
  });

  assert.equal(getPublishedItems([legacyTreeProject], routeConfig)[0]?.status, 'published');
});

void test('lists the live endpoint name and private route without changing web app routes', () => {
  const changed = project('private', 'Private', {
    status: 'unpublished_changes',
    endpointName: 'renamed-draft',
    publishedEndpointName: 'still-live',
    endpointAccess: 'internal',
    lastPublishedAt: '2026-09-15T00:00:00.000Z',
    publishedWebApps: [
      {
        uiGraphId: 'app',
        uiGraphName: 'Public app',
        slug: 'public-app',
        publishedAt: '2026-09-15T00:00:00.000Z',
        allowedEmails: [],
        status: 'published',
      },
    ],
  });

  const items = getPublishedItems([changed], routeConfig);
  assert.deepEqual(
    items.map(({ kind, label, route }) => ({ kind, label, route })),
    [
      { kind: 'endpoint', label: 'still-live', route: 'http://execution.test:8181/internal/workflows/still-live' },
      { kind: 'web-app', label: 'Public app', route: '/apps/public-app' },
    ],
  );
});
