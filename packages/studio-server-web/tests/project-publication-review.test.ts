import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNextProjectPublication,
  publicationSnapshotFieldsAgree,
  publicationSnapshotFromProject,
} from '../dashboard/projectPublicationReview';
import { carryEditedWebAppDrafts, parseWebAppAllowedEmailDraft } from '../dashboard/projectSettingsForm';
import type { WorkflowProjectItem, WorkflowProjectWebAppsResponse } from '../dashboard/types';

function project(): WorkflowProjectItem {
  return {
    id: 'tree-row',
    projectMetadataId: 'project-owner',
    revisionId: 'draft-1',
    name: 'Project',
    fileName: 'Project.rivet-project',
    relativePath: 'Project.rivet-project',
    absolutePath: '/workflows/Project.rivet-project',
    updatedAt: '2026-11-25T00:00:00.000Z',
    settings: {
      status: 'unpublished',
      endpointName: 'project',
      lastPublishedAt: null,
      publicationVersion: '4',
      publishedWebApps: [],
    },
  };
}

function snapshot(): WorkflowProjectWebAppsResponse {
  return {
    project: project(),
    projectId: 'project-owner',
    draftRevisionId: 'draft-1',
    publicationVersion: '4',
    hasMainGraph: true,
    webApps: [],
  };
}

void test('project snapshots retain server tokens and missing tokens stay unavailable', () => {
  assert.deepEqual(publicationSnapshotFromProject(project()), {
    expectedProjectId: 'project-owner',
    expectedDraftRevisionId: 'draft-1',
    expectedPublicationVersion: '4',
  });
  const missing = project();
  delete missing.projectMetadataId;
  delete missing.revisionId;
  delete missing.settings.publicationVersion;
  assert.deepEqual(publicationSnapshotFromProject(missing), {
    expectedProjectId: '',
    expectedDraftRevisionId: '',
    expectedPublicationVersion: '',
  });
});

void test('snapshot field agreement requires all three server identities to match', () => {
  assert.equal(publicationSnapshotFieldsAgree(snapshot()), true);
  for (const changedProject of [
    { ...project(), projectMetadataId: 'replacement-owner' },
    { ...project(), revisionId: 'newer-draft' },
    { ...project(), settings: { ...project().settings, publicationVersion: '5' } },
  ]) {
    // A stable tree row id does not establish project or revision ownership.
    assert.equal(publicationSnapshotFieldsAgree({ ...snapshot(), project: changedProject }), false);
  }
});

void test('field agreement leaves path, token availability and canonical version policy with callers', () => {
  const unavailable = snapshot();
  unavailable.project.relativePath = 'another-path.rivet-project';
  unavailable.project.projectMetadataId = unavailable.projectId = '';
  unavailable.project.revisionId = unavailable.draftRevisionId = '';
  unavailable.project.settings.publicationVersion = unavailable.publicationVersion = '01';
  assert.equal(publicationSnapshotFieldsAgree(unavailable), true);
});

void test('returned settings publications keep the owner, require a draft and advance exactly once', () => {
  const previous = publicationSnapshotFromProject(project());
  const next = { ...previous, expectedPublicationVersion: '5', expectedDraftRevisionId: 'draft-2' };
  assert.equal(isNextProjectPublication(next, previous), true);
  for (const rejected of [
    { ...next, expectedProjectId: 'replacement-owner' },
    { ...next, expectedDraftRevisionId: '' },
    { ...next, expectedDraftRevisionId: undefined },
    { ...next, expectedPublicationVersion: '4' },
    { ...next, expectedPublicationVersion: '6' },
  ]) {
    assert.equal(isNextProjectPublication(rejected, previous), false);
  }
});

void test('email drafts normalize separators, case and duplicates while retaining invalid entries for validation', () => {
  assert.deepEqual(
    parseWebAppAllowedEmailDraft(' First@Example.com; SECOND@example.com,first@example.com\n\n invalid value ; '),
    ['first@example.com', 'second@example.com', 'invalid value'],
  );
  assert.deepEqual(parseWebAppAllowedEmailDraft(' ;,\n '), []);
});

void test('draft reconciliation carries edits only for surviving previously known fields', () => {
  assert.deepEqual(
    carryEditedWebAppDrafts(
      { clean: 'old', edited: 'mine', removed: 'mine', orphan: 'mine', empty: '' },
      { clean: 'old', edited: 'old', removed: 'old', missing: 'old', empty: 'old' },
      { clean: 'new', edited: 'new', missing: 'new', fresh: 'new', empty: 'new' },
    ),
    { clean: 'new', edited: 'mine', missing: 'new', fresh: 'new', empty: '' },
  );
});

void test('draft reconciliation distinguishes own fields from prototype keys', () => {
  const edits = Object.fromEntries([
    ['constructor', 'my constructor'],
    ['__proto__', 'my prototype'],
  ]);
  const server = Object.fromEntries([
    ['constructor', 'server constructor'],
    ['__proto__', 'server prototype'],
  ]);
  assert.deepEqual(carryEditedWebAppDrafts(edits, {}, server), server);
  assert.deepEqual(carryEditedWebAppDrafts({}, server, server), server);
  const carried = carryEditedWebAppDrafts(edits, server, server);
  assert.deepEqual(carried, edits);
  assert.equal(Object.getPrototypeOf(carried), Object.prototype);
});
