import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGraphRunner, createProcessor, runGraph, type NodeId } from '../src/index.js';
import { makeUnusedOutputProject } from './outputSelectionFixtures.js';

void describe('SubGraph output selection across Node runtime modes', () => {
  for (const skipUnusedOutputs of [false, true]) {
    void it(`preserves requested results across public entrypoints with selection ${skipUnusedOutputs ? 'on' : 'off'}`, async () => {
      const fixture = makeUnusedOutputProject(skipUnusedOutputs);
      const expected = {
        result: { type: 'string', value: 'shared wanted' },
        cost: { type: 'number', value: 0 },
      };
      assert.deepEqual(await runGraph(fixture.project, { graph: fixture.graphId }), expected);

      for (const runtimeProfile of [undefined, 'compatible'] as const) {
        const created = createProcessor(fixture.project, { graph: fixture.graphId, runtimeProfile });
        const starts: NodeId[] = [];
        created.processor.on('nodeStart', ({ node }) => starts.push(node.id));
        try {
          for (let run = 0; run < 2; run++) {
            starts.length = 0;
            assert.deepEqual(await created.run(), expected);
            assert.equal(starts.length, fixture.expectedNodeStarts);
            assert.equal(
              starts.some((id) => id.startsWith('unused-')),
              !skipUnusedOutputs,
            );
          }
        } finally {
          created.dispose();
        }
      }

      const runner = createGraphRunner(fixture.project, { graph: fixture.graphId });
      try {
        assert.deepEqual(await runner.run(), expected);
        assert.deepEqual(await runner.run(), expected);
      } finally {
        runner.dispose();
      }
    });
  }
});
