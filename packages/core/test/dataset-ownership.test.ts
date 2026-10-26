import assert from 'node:assert/strict';
import test from 'node:test';
import { remapOwnedDatasets } from '../src/model/DatasetOwnership.js';
import type { ProjectId } from '../src/model/Project.js';
import type { CombinedDataset } from '../src/utils/serialization/serialization.js';

test('ownership remapping preserves data/IDs and does not mutate source or claim foreign datasets', () => {
  const source = 'source' as ProjectId,
    target = 'target' as ProjectId;
  const datasets = [
    {
      meta: { id: 'data', projectId: source, name: 'Data', description: '' },
      data: { id: 'data', rows: [{ id: 'row', data: ['source is ordinary text, not an identity binding'] }] },
    },
  ] as CombinedDataset[];
  const before = structuredClone(datasets);
  const copy = remapOwnedDatasets(datasets, source, target);
  assert.equal(copy[0]!.meta.projectId, target);
  assert.deepEqual(copy[0]!.data, datasets[0]!.data);
  assert.equal(copy[0]!.meta.id, datasets[0]!.meta.id);
  assert.deepEqual(datasets, before);
  assert.throws(() => remapOwnedDatasets(datasets, target, source), /ownership/);
});
