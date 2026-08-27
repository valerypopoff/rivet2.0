import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSourceWorkflowStatus,
  verifyMigrationState,
} from '../scripts/migrate-workflow-storage-lib.js';

test('deriveSourceWorkflowStatus distinguishes unpublished, published, and unpublished_changes states', () => {
  assert.equal(deriveSourceWorkflowStatus({
    relativePath: 'alpha/hello.rivet-project',
    endpointName: '',
    publishedEndpointName: '',
    lastPublishedAt: null,
    contents: '{"alpha":1}',
    datasetsContents: null,
    publishedContents: null,
    publishedDatasetsContents: null,
  }), 'unpublished');

  assert.equal(deriveSourceWorkflowStatus({
    relativePath: 'alpha/hello.rivet-project',
    endpointName: 'Hello-World',
    publishedEndpointName: 'hello-world',
    lastPublishedAt: '2026-04-07T12:00:00.000Z',
    contents: '{"alpha":1}',
    datasetsContents: '{"rows":[]}',
    publishedContents: '{"alpha":1}',
    publishedDatasetsContents: '{"rows":[]}',
  }), 'published');

  assert.equal(deriveSourceWorkflowStatus({
    relativePath: 'alpha/hello.rivet-project',
    endpointName: 'hello-world',
    publishedEndpointName: 'hello-world',
    lastPublishedAt: '2026-04-07T12:00:00.000Z',
    contents: '{"alpha":2}',
    datasetsContents: '{"rows":[]}',
    publishedContents: '{"alpha":1}',
    publishedDatasetsContents: '{"rows":[]}',
  }), 'unpublished_changes');
});

test('verifyMigrationState accepts matching folders, projects, and non-regressing recording summaries', () => {
  const summary = verifyMigrationState({
    sourceFolderPaths: ['alpha', 'alpha/nested'],
    targetFolderPaths: ['alpha', 'alpha/nested', 'beta'],
    sourceProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'hello-world',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
    ],
    targetProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'hello-world',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
      {
        relativePath: 'beta/extra.rivet-project',
        endpointName: '',
        lastPublishedAt: null,
        status: 'unpublished',
      },
    ],
    sourceRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 2,
        failedRuns: 1,
        suspiciousRuns: 0,
        latestRunAt: '2026-04-07T13:00:00.000Z',
      },
    ],
    targetRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 3,
        failedRuns: 1,
        suspiciousRuns: 1,
        latestRunAt: '2026-04-07T14:00:00.000Z',
      },
    ],
  });

  assert.deepEqual(summary, {
    sourceProjectCount: 1,
    targetProjectCount: 2,
    sourceFolderCount: 2,
    targetFolderCount: 3,
    sourceRecordingWorkflowCount: 1,
    targetRecordingWorkflowCount: 1,
  });
});

test('verifyMigrationState reports missing folders, mismatched projects, and regressed recording summaries', () => {
  assert.throws(() => verifyMigrationState({
    sourceFolderPaths: ['alpha', 'alpha/nested'],
    targetFolderPaths: ['alpha'],
    sourceProjectState: [],
    targetProjectState: [],
    sourceRecordingState: [],
    targetRecordingState: [],
  }), /Managed workflow folder is missing: alpha\/nested/);

  assert.throws(() => verifyMigrationState({
    sourceFolderPaths: ['alpha'],
    targetFolderPaths: ['alpha'],
    sourceProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'hello-world',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
    ],
    targetProjectState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        endpointName: 'different-endpoint',
        lastPublishedAt: '2026-04-07T12:00:00.000Z',
        status: 'published',
      },
    ],
    sourceRecordingState: [],
    targetRecordingState: [],
  }), /Managed workflow mismatch for alpha\/hello\.rivet-project/);

  assert.throws(() => verifyMigrationState({
    sourceFolderPaths: ['alpha'],
    targetFolderPaths: ['alpha'],
    sourceProjectState: [],
    targetProjectState: [],
    sourceRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 2,
        failedRuns: 1,
        suspiciousRuns: 1,
        latestRunAt: '2026-04-07T13:00:00.000Z',
      },
    ],
    targetRecordingState: [
      {
        relativePath: 'alpha/hello.rivet-project',
        totalRuns: 1,
        failedRuns: 1,
        suspiciousRuns: 1,
        latestRunAt: '2026-04-07T12:00:00.000Z',
      },
    ],
  }), /Managed recording count regressed for alpha\/hello\.rivet-project/);
});
