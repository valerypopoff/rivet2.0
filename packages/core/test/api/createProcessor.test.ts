import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { coreCreateProcessor, coreRunGraph } from '../../src/index.js';
import { loadTestGraphs } from '../testUtils.js';

void describe('coreCreateProcessor lifecycle', () => {
  void it('rejects a run whose host signal was already aborted', async () => {
    const project = await loadTestGraphs();
    const controller = new AbortController();
    controller.abort();
    let startCalls = 0;
    const options = {
      abortSignal: controller.signal,
      graph: 'Passthrough',
      inputs: { input: 'must not finish' },
      onStart: () => {
        startCalls += 1;
      },
    };
    const created = coreCreateProcessor(project, options);

    await assert.rejects(
      created.run(),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    await assert.rejects(
      coreRunGraph(project, options),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    assert.equal(startCalls, 0);
    created.dispose();
  });

  void it('releases and reattaches its run-scoped host abort listener', async () => {
    const controller = new AbortController();
    const created = coreCreateProcessor(await loadTestGraphs(), {
      abortSignal: controller.signal,
      graph: 'Passthrough',
      inputs: { input: 'repeatable' },
    });

    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    await created.run();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

    await created.run();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);

    const unstarted = coreCreateProcessor(await loadTestGraphs(), {
      abortSignal: controller.signal,
      graph: 'Passthrough',
      inputs: { input: 'unused' },
    });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    unstarted.dispose();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    created.dispose();
  });
});
