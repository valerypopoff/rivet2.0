import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicationPreconditions,
  assertEndpointAccess,
  createEndpointPublication,
  nextPublicationVersion,
  normalizeEndpointSettings,
} from '../routes/workflows/publication-policy.js';

const actual = { projectId: 'project', publicationVersion: '9', draftRevisionId: 'draft', endpointPublished: true };
const reviewed = { expectedProjectId: 'project', expectedPublicationVersion: '9', expectedDraftRevisionId: 'draft' };

test('publication policy distinguishes draft publication from policy-only changes and fences identity', () => {
  assertPublicationPreconditions(reviewed, actual, 'publish-endpoint');
  const olderDraft = { ...reviewed, expectedDraftRevisionId: 'old' };
  assertPublicationPreconditions(olderDraft, actual, 'unpublish-endpoint');
  assertPublicationPreconditions(olderDraft, actual, 'set-endpoint-access');
  for (const kind of ['publish-endpoint', 'publish-web-apps', 'restore-version'] as const) {
    assert.throws(() => assertPublicationPreconditions(olderDraft, actual, kind), {
      status: 409,
      code: 'publication_draft_changed',
    });
  }
  assert.throws(
    () =>
      assertPublicationPreconditions({ ...reviewed, expectedProjectId: 'replacement' }, actual, 'unpublish-endpoint'),
    { status: 409, code: 'publication_project_changed' },
  );
  assert.throws(
    () =>
      assertPublicationPreconditions({ ...reviewed, expectedPublicationVersion: '8' }, actual, 'set-web-app-access'),
    { status: 409, code: 'publication_state_changed' },
  );
});

test('endpoint access fails closed without active publication and rejects invalid values', () => {
  for (const endpointPublished of [false, undefined]) {
    assert.throws(
      () => assertPublicationPreconditions(reviewed, { ...actual, endpointPublished }, 'set-endpoint-access'),
      { status: 409 },
    );
  }
  for (const access of ['public', 'internal']) assertEndpointAccess(access);
  for (const access of [undefined, null, 'external', {}, true])
    assert.throws(() => assertEndpointAccess(access), { status: 400 });
});

test('publication identity and version policy keep normalized endpoints and exact large versions', () => {
  assert.equal(nextPublicationVersion('9007199254740993'), '9007199254740994');
  assert.equal(nextPublicationVersion(undefined), '1');
  for (const value of ['01', '-1', '1.0', 'garbage']) assert.throws(() => nextPublicationVersion(value));
  assert.deepEqual(normalizeEndpointSettings({ endpointName: ' Hello-World ' }), { endpointName: 'Hello-World' });
  assert.throws(() => normalizeEndpointSettings({ endpointName: '/hello world/' }), { status: 400 });
  assert.throws(() => createEndpointPublication({ endpointName: '' }), { status: 400 });
  const first = createEndpointPublication({ endpointName: 'hello' });
  const second = createEndpointPublication({ endpointName: 'hello' });
  assert.equal(first.endpointName, 'hello');
  assert.notEqual(first.versionId, second.versionId);
  assert.ok(Number.isFinite(Date.parse(first.publishedAt)));
});
