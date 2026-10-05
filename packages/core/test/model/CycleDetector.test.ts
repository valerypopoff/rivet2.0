import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findStronglyConnectedComponents } from '../../src/model/CycleDetector';

describe('CycleDetector', () => {
  it('finds strongly connected components in a mixed graph', () => {
    const [a, b, c, d] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] as const;
    const nodes = [a, b, c, d];
    const adjacency = new Map<(typeof nodes)[number], (typeof nodes)[number][]>([
      [a, [b]],
      [b, [a, c]],
      [c, []],
      [d, [d]],
    ]);

    const components = findStronglyConnectedComponents(nodes, (node) => adjacency.get(node) ?? []).map((component) =>
      component.map((node) => node.id).sort(),
    );

    assert.deepEqual(
      components.sort((left, right) => left.join(',').localeCompare(right.join(','))),
      [['a', 'b'], ['c'], ['d']],
    );
  });
});
