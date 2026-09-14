import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProcessEventMessageMap } from '@valerypopoff/rivet2-core';
import { createEvaluationEventCollector } from '@valerypopoff/rivet2-evaluations';

test('remote executor payload contracts remain assignable to the shared evaluation collector', () => {
  const collector = createEvaluationEventCollector('full');

  // These assignments intentionally compile the three live remote-transport
  // payloads against the public collector API. Keeping them outside the hook
  // prevents a Core event-contract change from being masked by an `any` cast.
  const llmCallFinished: (event: ProcessEventMessageMap['llmCallFinished']) => void = collector.llmCallFinished;
  const llmProfileAttempt: (event: ProcessEventMessageMap['llmProfileAttempt']) => void = collector.llmProfileAttempt;
  const toolCallFinished: (event: ProcessEventMessageMap['toolCallFinished']) => void = collector.toolCallFinished;

  assert.equal(typeof llmCallFinished, 'function');
  assert.equal(typeof llmProfileAttempt, 'function');
  assert.equal(typeof toolCallFinished, 'function');
});
