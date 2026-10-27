import assert from 'node:assert/strict';
import test from 'node:test';
import { RunCostLedger } from '../../src/model/RunCostLedger.js';

test('provider call identities are counted once and missing pricing stays unknown', () => {
  const ledger = new RunCostLedger();
  assert.deepEqual(ledger.snapshot(), { status: 'complete', knownCostUsd: 0 });
  const call = { callId: 'call', pricing: { status: 'known', costUsd: 0.2 } } as never;
  ledger.observeChat(call);
  ledger.observeChat(call);
  ledger.observeClassifier({
    family: 'classifier',
    attemptIndex: 0,
    eventId: 'decision',
    classifierUsage: { estimatedCostUsd: 0.03 },
  } as never);
  assert.deepEqual(ledger.snapshot(), { status: 'complete', knownCostUsd: 0.2 + 0.03 });
  ledger.observeChat({ callId: 'unknown', pricing: { status: 'unknown' } } as never);
  assert.deepEqual(ledger.snapshot(), { status: 'partial', knownCostUsd: 0.2 + 0.03 });
});

test('unobservable, invalid or overflowing calls cannot become free and legacy costs remain partial', () => {
  const ledger = new RunCostLedger();
  ledger.observeClassifier({
    family: 'classifier',
    attemptIndex: 0,
    eventId: 'bad',
    classifierUsage: { estimatedCostUsd: -1 },
  } as never);
  assert.deepEqual(ledger.snapshot(), { status: 'unknown', knownCostUsd: null });
  ledger.observeLegacy('legacy', 0.5);
  ledger.observeLegacy('legacy', 0.5);
  assert.deepEqual(ledger.snapshot(), { status: 'partial', knownCostUsd: 0.5 });
  const overflowing = new RunCostLedger();
  for (const callId of ['large-a', 'large-b']) {
    overflowing.observeChat({ callId, pricing: { status: 'known', costUsd: Number.MAX_VALUE } } as never);
  }
  assert.deepEqual(overflowing.snapshot(), { status: 'unknown', knownCostUsd: null });
});

test('pending execution distinguishes absent evidence from an explicitly observed zero', () => {
  const ledger = new RunCostLedger();
  assert.deepEqual(ledger.snapshot(true), { status: 'unknown', knownCostUsd: null });
  ledger.observeChat({ callId: 'free', pricing: { status: 'known', costUsd: 0 } } as never);
  assert.deepEqual(ledger.snapshot(true), { status: 'partial', knownCostUsd: 0 });
  assert.deepEqual(ledger.snapshot(), { status: 'complete', knownCostUsd: 0 });
  ledger.observeChat({ callId: 'paid', pricing: { status: 'known', costUsd: 0.25 } } as never);
  assert.deepEqual(ledger.snapshot(true), { status: 'partial', knownCostUsd: 0.25 });
});
