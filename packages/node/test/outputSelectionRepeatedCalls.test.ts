import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createGraphRunner,
  createProcessor,
  ExecutionRecorder,
  loadProjectFromString,
  serializeProject,
  type ProcessEvents,
} from '../src/index.js';
import { makeLoopedSplitOutputProject } from './outputSelectionFixtures.js';

void describe('output pruning with repeated headless child calls', { timeout: 20_000 }, () => {
  for (const isSplitSequential of [false, true]) {
    for (const skipUnusedOutputs of [false, true]) {
      for (const runtimeProfile of [undefined, 'compatible'] as const) {
        void it(`loops, ${isSplitSequential ? 'sequential' : 'parallel'} items, pruning ${skipUnusedOutputs}, runtime ${runtimeProfile ?? 'default'}`, async () => {
          const fixture = makeLoopedSplitOutputProject(skipUnusedOutputs, isSplitSequential);
          // Exercise the saved-project contract, not only in-memory authored objects.
          const project = loadProjectFromString(serializeProject(fixture.project));
          const expected = { result: { type: 'any[]', value: [[4, 5, 6]] }, cost: { type: 'number', value: 0 } };
          const created = createProcessor(project, {
            graph: fixture.graphId,
            inputs: { items: { type: 'number[]', value: [1, 2, 3] } },
            runtimeProfile,
          });
          const rootRunIds = new Set<string>();
          try {
            for (let repeat = 0; repeat < 2; repeat++) {
              const recorder = new ExecutionRecorder();
              recorder.record(created.processor);
              assert.deepEqual(await created.run(), expected);
              const saved = ExecutionRecorder.deserializeFromString(recorder.serialize());
              const graphStarts = saved.events.filter((event) => event.type === 'graphStart');
              const root = graphStarts.find((event) => event.data.graphId === fixture.graphId)!;
              rootRunIds.add(root.data.execution!.rootRunId);
              const children = graphStarts.filter((event) => event.data.graphId === fixture.childGraphId);
              assert.equal(children.length, 9, 'three loop iterations, each with three split items');
              assert.equal(new Set(children.map((event) => event.data.execution!.graphRunId)).size, 9);
              const processIds = new Set(children.map((event) => event.data.execution!.executor!.processId));
              assert.equal(processIds.size, 3, 'each loop iteration has its own caller process');
              for (const processId of processIds) {
                assert.deepEqual(
                  children
                    .filter((event) => event.data.execution!.executor!.processId === processId)
                    .map((event) => event.data.execution!.executor!.splitIndex)
                    .sort(),
                  [0, 1, 2],
                );
              }
              for (const child of children) {
                assert.equal(child.data.execution!.parentGraphRunId, root.data.execution!.graphRunId);
                const starts = saved.events.filter(
                  (event) =>
                    event.type === 'nodeStart' && event.data.execution?.graphRunId === child.data.execution!.graphRunId,
                );
                assert.equal(starts.length, skipUnusedOutputs ? 3 : 5);
              }
              const callerFinishes = saved.events.filter(
                (event) => event.type === 'nodeFinish' && event.data.nodeId === 'subgraph',
              );
              assert.equal(callerFinishes.length, 3);
              assert.deepEqual(
                callerFinishes.map((event) => event.data.outputs.wanted?.value),
                [
                  [2, 3, 4],
                  [3, 4, 5],
                  [4, 5, 6],
                ],
              );
              for (const event of callerFinishes) {
                assert.equal(
                  event.data.outputs.unused?.type,
                  skipUnusedOutputs ? 'control-flow-excluded[]' : 'string[]',
                );
              }

              const replay = createProcessor(project, { graph: fixture.graphId });
              const replayChildren: ProcessEvents['graphStart'][] = [];
              const replayFinishes: ProcessEvents['nodeFinish'][] = [];
              replay.processor.on('graphStart', (event) => {
                replayChildren.push(event);
              });
              replay.processor.on('nodeFinish', (event) => {
                replayFinishes.push(event);
              });
              try {
                assert.deepEqual(await replay.processor.replayRecording(saved), expected);
                const replayRoot = replayChildren.find((event) => event.graph.metadata!.id === fixture.graphId)!;
                const replayCalls = replayChildren.filter((event) => event.graph.metadata!.id === fixture.childGraphId);
                assert.equal(replayCalls.length, 9);
                assert.equal(new Set(replayCalls.map((event) => event.execution!.graphRunId)).size, 9);
                for (const child of replayCalls) {
                  assert.equal(child.execution!.parentGraphRunId, replayRoot.execution!.graphRunId);
                }
                assert.deepEqual(
                  replayFinishes.filter((event) => event.node.id === 'subgraph').map((event) => event.outputs),
                  callerFinishes.map((event) => event.data.outputs),
                );
              } finally {
                replay.dispose();
              }
            }
            assert.equal(rootRunIds.size, 2, 'reused processors must allocate fresh run identities');
          } finally {
            created.dispose();
          }

          const runner = createGraphRunner(project, { graph: fixture.graphId });
          try {
            const results = await Promise.all(
              [1, 10].map((seed) =>
                runner.run({
                  inputs: { items: { type: 'number[]', value: [seed, seed + 1, seed + 2] } },
                }),
              ),
            );
            assert.deepEqual(
              results.map((result) => result.result?.value),
              [[[4, 5, 6]], [[13, 14, 15]]],
            );
          } finally {
            runner.dispose();
          }
        });
      }
    }
  }
});
