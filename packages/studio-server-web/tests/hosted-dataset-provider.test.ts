import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { CombinedDataset, DatasetId, ProjectId } from '@valerypopoff/rivet2-core';
import { HostedDatasetProvider } from '../io/HostedDatasetProvider.js';

beforeEach(() => {
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new IDBFactory() });
});

function dataset(projectId: ProjectId, id = 'shared'): CombinedDataset {
  return {
    meta: { id: id as DatasetId, projectId, name: id, description: '' },
    data: { id: id as DatasetId, rows: [{ id: 'row', data: [projectId] }] },
  };
}

test('hosted imports replace stale datasets and inherited cleanup removes only the requested owner', async () => {
  const provider = new HostedDatasetProvider();
  const first = 'first' as ProjectId;
  const second = 'second' as ProjectId;
  await provider.importDatasetsForProject(first, [dataset(first)]);
  await provider.importDatasetsForProject(second, [dataset(second)]);
  assert.deepEqual(await provider.exportDatasetsForProject(first), [dataset(first)]);
  await provider.importDatasetsForProject(first, [dataset(first, 'replacement')], { activate: false });
  assert.deepEqual(await provider.exportDatasetsForProject(first), [dataset(first, 'replacement')]);
  await provider.deleteStoredDatasetsForProject(first);
  assert.equal(provider.currentProjectId, second);
  assert.deepEqual(await provider.exportDatasetsForProject(first), []);
  assert.deepEqual(await provider.exportDatasetsForProject(second), [dataset(second)]);
  await provider.deleteStoredDatasetsForProject(second);
  assert.deepEqual(await provider.getDatasetsForProject(second), []);
  const reloaded = new HostedDatasetProvider();
  assert.deepEqual(await reloaded.exportDatasetsForProject(second), []);
});

test('failed hosted replacement rolls back deletion and preserves the active dataset cache', async (t) => {
  const provider = new HostedDatasetProvider();
  const owner = 'owner' as ProjectId;
  await provider.importDatasetsForProject(owner, [dataset(owner)]);
  const put = IDBObjectStore.prototype.put;
  const failingPut = t.mock.method(
    IDBObjectStore.prototype,
    'put',
    function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'data') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    },
  );
  await assert.rejects(provider.importDatasetsForProject(owner, [dataset(owner, 'new')]), /Quota exceeded/);
  failingPut.mock.restore();
  assert.deepEqual(await provider.exportDatasetsForProject(owner), [dataset(owner)]);
  assert.deepEqual(await new HostedDatasetProvider().exportDatasetsForProject(owner), [dataset(owner)]);
});

test('cancelling hosted replacement after deletion rolls back both stores', async (t) => {
  const provider = new HostedDatasetProvider();
  const owner = 'owner' as ProjectId;
  await provider.importDatasetsForProject(owner, [dataset(owner)]);
  const controller = new AbortController();
  const put = IDBObjectStore.prototype.put;
  t.mock.method(IDBObjectStore.prototype, 'put', function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
    const request = put.apply(this, args);
    if (this.name === 'datasets') controller.abort();
    return request;
  });
  await assert.rejects(
    provider.importDatasetsForProject(owner, [dataset(owner, 'new')], { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.deepEqual(await provider.exportDatasetsForProject(owner), [dataset(owner)]);
  assert.deepEqual(await new HostedDatasetProvider().exportDatasetsForProject(owner), [dataset(owner)]);
});

test('inactive hosted imports and obsolete selections never select a different tab', async () => {
  const provider = new HostedDatasetProvider();
  const active = 'active' as ProjectId;
  const inactive = 'inactive' as ProjectId;
  await provider.importDatasetsForProject(active, [dataset(active)]);
  await provider.importDatasetsForProject(inactive, [dataset(inactive)], { activate: false });
  await assert.rejects(provider.importDatasetsForProject(inactive, [], { isCurrent: () => false }), {
    name: 'AbortError',
  });
  assert.equal(provider.currentProjectId, active);
  assert.deepEqual(await provider.exportDatasetsForProject(active), [dataset(active)]);
  assert.deepEqual(await provider.exportDatasetsForProject(inactive), [dataset(inactive)]);
});
