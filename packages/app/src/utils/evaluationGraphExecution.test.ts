import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvaluationEventCollector, EvaluationGraphExecutionError } from '@valerypopoff/rivet2-evaluations';
import { executeEvaluationGraph } from './evaluationGraphExecution.js';

for (const mode of ['browser', 'node'] as const) {
  for (const outcome of ['success', 'failure', 'aborted'] as const) {
    test(`${mode} trial ${outcome} preserves evidence and settles capture before persistence`, async () => {
      const captured = createEvaluationEventCollector('full');
      captured.providerAttempts.push({ provider: 'test', status: outcome });
      const steps: string[] = [];
      const controller = new AbortController();
      const error = new Error('Execution failed');
      const recording = { id: 'artifact', retention: 'temporary' as const };
      let calls = 0;
      const execute = () =>
        executeEvaluationGraph({
          captured,
          startedAt: Date.now() - 10,
          signal: controller.signal,
          execute: async () => {
            calls++;
            steps.push('execute');
            if (outcome === 'aborted') controller.abort(error);
            if (outcome !== 'success') throw error;
            return { output: { type: 'string', value: 'result' } };
          },
          ...(mode === 'node'
            ? {
                settleCapture: async (failed: boolean) => {
                  assert.equal(failed, outcome !== 'success');
                  steps.push('settle');
                  captured.metrics.modelCallCount = 3;
                },
              }
            : {}),
          persistRecording: async () => {
            steps.push('persist');
            return recording;
          },
        });
      if (outcome === 'success') {
        const result = await execute();
        assert.deepEqual(result.outputs, { output: 'result' });
        assert.equal(result.recording, recording);
        assert.equal(result.providerAttempts, captured.providerAttempts);
      } else {
        await assert.rejects(execute, (actual) => {
          if (outcome === 'aborted') assert.equal(actual, error);
          else {
            assert.ok(actual instanceof EvaluationGraphExecutionError);
            assert.equal(actual.message, error.message);
            assert.equal(actual.metrics, captured.metrics);
            assert.equal(actual.recording, recording);
            assert.equal(actual.providerAttempts, captured.providerAttempts);
          }
          return true;
        });
      }
      assert.deepEqual(steps, mode === 'node' ? ['execute', 'settle', 'persist'] : ['execute', 'persist']);
      assert.equal(calls, 1, 'Execution must never be replayed');
      assert.ok(captured.metrics.durationMs >= 0);
      if (mode === 'node') assert.equal(captured.metrics.modelCallCount, 3);
    });
  }
}

test('empty evidence is omitted and AbortError identity survives without an aborted signal', async () => {
  const error = new DOMException('Cancelled', 'AbortError');
  const captured = createEvaluationEventCollector('full');
  const base = { captured, startedAt: Date.now(), persistRecording: async () => undefined };
  const result = await executeEvaluationGraph({ ...base, execute: async () => ({}) });
  assert.equal('recording' in result, false);
  assert.equal('providerAttempts' in result, false);
  await assert.rejects(
    () =>
      executeEvaluationGraph({
        ...base,
        execute: async () => {
          throw error;
        },
      }),
    (actual) => actual === error,
  );
});
