import assert from 'node:assert/strict';
import test from 'node:test';
import { compareProjects, getProjectNodeFieldComparisons } from '../../src/utils/projectComparison.js';
import type { Project } from '../../src/model/Project.js';

function project(id: string, target: string, version = 'latest', text = 'same'): Project {
  return {
    metadata: { id, title: 'Project', description: '' },
    graphs: {
      g: {
        metadata: { id: 'g', name: 'Graph' },
        nodes: [
          {
            id: 'n',
            type: 'subGraph',
            title: 'Call',
            data: { targetProjectId: target, targetVersion: version, graphId: 'target', text },
            visualData: { x: 0, y: 0 },
          },
        ],
        connections: [],
      },
    },
  } as Project;
}
const identity = {
  pairs: [
    { beforeProjectId: 'a', afterProjectId: 'a1' },
    { beforeProjectId: 'b', afterProjectId: 'b1' },
  ],
};
void test('side-specific equivalence suppresses copied IDs without mutating saved or live contents', () => {
  const before = project('a', 'b');
  const after = project('a1', 'b1');
  const saved = JSON.stringify([before, after]);
  assert.equal(compareProjects(before, after).graphs.g?.nodes.n?.kind, 'changed');
  const diff = compareProjects(before, after, identity);
  assert.equal(diff.metadataChanged, false);
  assert.equal(diff.graphs.g?.nodes.n?.kind, 'unchanged');
  assert.equal(JSON.stringify([before, after]), saved);
  assert.equal(compareProjects(project('a', 'a'), project('a1', 'a1'), identity).graphs.g?.nodes.n?.kind, 'unchanged');
  assert.equal(compareProjects(before, project('a1', 'b'), identity).graphs.g?.nodes.n?.kind, 'changed');
  assert.equal(compareProjects(project('a', 'b1'), after, identity).graphs.g?.nodes.n?.kind, 'changed');
});
void test('real version/target changes and raw inspector values survive equivalence', () => {
  const diff = compareProjects(project('a', 'b'), project('a1', 'foreign', 'published'), identity);
  const fields = getProjectNodeFieldComparisons(diff.graphs.g!.nodes.n!);
  assert.equal(fields.find((f) => f.path.join('.') === 'data.targetProjectId')?.before, 'b');
  assert.equal(fields.find((f) => f.path.join('.') === 'data.targetProjectId')?.after, 'foreign');
  assert.ok(fields.some((f) => f.path.join('.') === 'data.targetVersion'));
  const other = compareProjects(project('a', 'b'), project('a1', 'b1', 'latest', 'edited'), identity);
  assert.deepEqual(
    getProjectNodeFieldComparisons(other.graphs.g!.nodes.n!).map((f) => f.path.join('.')),
    ['data.text'],
  );
});
void test('aliases, disabled variant targets and library sources compare by the confirmed side without hiding foreign token-like IDs', () => {
  const before = project('a', 'b');
  const after = project('a1', 'b1');
  for (const [p, target] of [
    [before, 'b'],
    [after, 'b1'],
  ] as const) {
    const source = p.graphs.g!.nodes[0]!;
    source.disabled = true;
    source.variants = [{ id: 'variant', name: 'Variant', data: { targetProjectId: target } }] as never;
    p.graphs.g!.nodes.push({
      ...source,
      id: 'alias',
      type: 'referencedGraphAlias',
      data: { projectId: target, graphId: 'target' },
      variants: [{ id: 'alias-variant', name: 'Variant', data: { projectId: target } }],
    } as never);
    p.nodePrefabs = { source: { id: 'source', sourceNode: source } } as never;
  }
  const original = JSON.stringify([before, after]);
  const result = compareProjects(before, after, identity);
  assert.equal(result.graphs.g?.kind, 'unchanged');
  assert.equal(result.nodePrefabs?.source?.kind, 'unchanged');
  assert.equal(JSON.stringify([before, after]), original);
  assert.equal(compareProjects(before, project('a1', '["pair",1]'), identity).graphs.g?.nodes.n?.kind, 'changed');
  const changed = structuredClone(after);
  (changed.graphs.g!.nodes[0]!.variants![0]!.data as { targetProjectId: string }).targetProjectId = 'b';
  assert.equal(compareProjects(before, changed, identity).graphs.g?.nodes.n?.kind, 'changed');
});
