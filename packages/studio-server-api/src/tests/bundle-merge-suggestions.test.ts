import assert from 'node:assert/strict';
import test from 'node:test';
import { type ProjectId, type GraphId, type DatasetId } from '@valerypopoff/rivet2-node';
import {
  suggestBundleMergeChanges,
  type BundleMergeSavedContent,
} from '../routes/workflows/bundle-merge-suggestions.js';
import { remapBundleProject } from '../routes/workflows/remap-bundle-project.js';
import { projectBundleFixture } from './helpers/project-bundle-fixture.js';

function copies() {
  const fixture = projectBundleFixture();
  const originals = [fixture.root.project, fixture.child.project];
  const source = originals.map((project, index) => ({
    projectId: `copy-${index}`,
    title: project.metadata.title,
    relativePath: `${index}.rivet-project`,
  }));
  const destination = originals.map((project, index) => ({
    projectId: project.metadata.id,
    title: project.metadata.title,
    relativePath: `${index}.rivet-project`,
  }));
  const values = new Map<string, BundleMergeSavedContent>();
  const ids = new Map(originals.map((project, index) => [project.metadata.id, `copy-${index}` as ProjectId]));
  originals.forEach((project, index) => {
    values.set(project.metadata.id, { project: structuredClone(project), attached: {}, datasets: null });
    const copy = structuredClone(project);
    remapBundleProject(copy, ids);
    copy.metadata.path = '/another/server/path';
    values.set(source[index]!.projectId, { project: copy, attached: {}, datasets: null });
  });
  const compare = () => suggestBundleMergeChanges(source, destination, async (id) => values.get(id)!);
  return { source, destination, values, compare };
}

test('unchanged duplicates ignore new project IDs, discovery paths and internal reference labels', async () => {
  const fixture = copies();
  const original = fixture.values.get(fixture.destination[0]!.projectId)!.project;
  original.references = [
    { id: fixture.destination[1]!.projectId as ProjectId, title: 'Old label', hintPaths: ['old/path'] },
  ];
  const copy = fixture.values.get('copy-0')!.project;
  copy.references = [{ id: 'copy-1' as ProjectId, title: 'Copied label' }];
  const before = structuredClone([...fixture.values]);
  assert.deepEqual(
    (await fixture.compare()).map((value) => value.state),
    ['unchanged', 'unchanged'],
  );
  assert.deepEqual([...fixture.values], before);
});

for (const change of ['graph name', 'node contents', 'attached data', 'plugins', 'description', 'datasets'] as const) {
  test(`saved ${change} changes are suggested as replacements`, async () => {
    const fixture = copies();
    const value = fixture.values.get('copy-0')!;
    const graph = Object.values(value.project.graphs)[0]!;
    if (change === 'graph name') graph.metadata!.name += ' changed';
    if (change === 'node contents') graph.nodes[0]!.title += ' changed';
    if (change === 'attached data') value.attached.newValue = 'changed';
    if (change === 'plugins') value.project.plugins = [{ type: 'built-in', id: 'test-plugin', name: 'Test plugin' }];
    if (change === 'description') value.project.metadata.description += ' changed';
    if (change === 'datasets')
      value.datasets = [
        {
          meta: { id: 'data' as DatasetId, projectId: 'copy-0' as ProjectId, name: 'Data', description: '' },
          data: { id: 'data' as DatasetId, rows: [] },
        },
      ];
    assert.deepEqual(
      (await fixture.compare()).map((value) => value.state),
      ['changed', 'unchanged'],
    );
  });
}

test('dataset ownership is normalized, while row edits and removals still count', async () => {
  const fixture = copies();
  for (const id of ['copy-0', fixture.destination[0]!.projectId])
    fixture.values.get(id)!.datasets = [
      {
        meta: { id: 'data' as DatasetId, projectId: id as ProjectId, name: 'Data', description: '' },
        data: { id: 'data' as DatasetId, rows: [{ id: 'row', data: ['same'] }] },
      },
    ];
  assert.equal((await fixture.compare())[0]!.state, 'unchanged');
  fixture.values.get('copy-0')!.datasets![0]!.data.rows[0]!.data = ['changed'];
  assert.equal((await fixture.compare())[0]!.state, 'changed');
  fixture.values.get('copy-0')!.datasets = null;
  assert.equal((await fixture.compare())[0]!.state, 'changed');
});

test('new members are additions even when they clone graphs already matched by another member', async () => {
  const fixture = copies();
  const value = structuredClone(fixture.values.get('copy-1')!);
  value.project.metadata.id = 'new' as ProjectId;
  fixture.source.push({ projectId: 'new', title: 'New', relativePath: 'New.rivet-project' });
  fixture.values.set('new', value);
  const result = await fixture.compare();
  assert.deepEqual(
    result.map((value) => value.state),
    ['unchanged', 'unchanged', 'new'],
  );
  assert.equal(result[2]!.targetProjectId, undefined);
});

test('a renamed member has an editable graph-identity suggestion and is never hidden as unchanged', async () => {
  const fixture = copies();
  fixture.source[1]!.relativePath = 'Moved/Child.rivet-project';
  fixture.source[1]!.title = 'Renamed';
  const result = (await fixture.compare())[1]!;
  assert.equal(result.state, 'changed');
  assert.equal(result.targetProjectId, fixture.destination[1]!.projectId);
});

test('ambiguous graph matches stay visible without an automatic replacement', async () => {
  const fixture = copies();
  const duplicate = structuredClone(fixture.values.get(fixture.destination[1]!.projectId)!);
  duplicate.project.metadata.id = 'another' as ProjectId;
  fixture.destination.push({
    projectId: 'another' as ProjectId,
    title: 'Another',
    relativePath: 'Another.rivet-project',
  });
  fixture.values.set('another', duplicate);
  fixture.source[1]!.relativePath = 'Moved/Child.rivet-project';
  fixture.source[1]!.title = 'Renamed';
  const result = (await fixture.compare())[1]!;
  assert.deepEqual(result, { sourceProjectId: 'copy-1', state: 'ambiguous' });
});

test('new graph identities without a destination counterpart default to additions', async () => {
  const fixture = copies();
  const value = fixture.values.get('copy-1')!;
  const graph = Object.values(value.project.graphs)[0]!;
  graph.metadata!.id = 'brand-new' as GraphId;
  value.project.graphs = { ['brand-new' as GraphId]: graph };
  fixture.source[1]!.relativePath = 'New.rivet-project';
  fixture.source[1]!.title = 'New';
  assert.equal((await fixture.compare())[1]!.state, 'new');
});

test('comparison bounds concurrent reads and stops scheduling after a failed batch', async () => {
  const fixture = copies();
  const many = Array.from({ length: 9 }, (_, index) => ({
    projectId: String(index),
    title: String(index),
    relativePath: `${index}.rivet-project`,
  }));
  let active = 0,
    peak = 0,
    reads = 0;
  await assert.rejects(
    suggestBundleMergeChanges(many, fixture.destination, async () => {
      reads++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (reads <= 4) throw new Error('storage unavailable');
      return fixture.values.get('copy-0')!;
    }),
    /storage unavailable/,
  );
  assert.equal(peak, 4);
  assert.equal(reads, 4);
});

test('empty source or destination needs no project-content reads', async () => {
  const fixture = copies();
  let reads = 0;
  const unavailable = async (): Promise<BundleMergeSavedContent> => {
    reads++;
    throw new Error('Unrelated saved contents are unavailable');
  };
  assert.deepEqual(await suggestBundleMergeChanges([], fixture.destination, unavailable), []);
  assert.deepEqual(
    await suggestBundleMergeChanges(fixture.source, [], unavailable),
    fixture.source.map((project) => ({ sourceProjectId: project.projectId, state: 'new' })),
  );
  assert.equal(reads, 0);
});
