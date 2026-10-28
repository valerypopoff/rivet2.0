import assert from 'node:assert/strict';
import test from 'node:test';
import { RunCostLedger, type RunCostFamily, type RunCostSnapshot } from '../../src/model/RunCostLedger.js';

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
  overflowing.observeClassifier({
    family: 'classifier',
    attemptIndex: 0,
    eventId: 'valid',
    classifierUsage: { estimatedCostUsd: 1 },
  } as never);
  assert.deepEqual(overflowing.breakdown(), {
    llm: { status: 'unknown', knownCostUsd: null },
    decisionAI: { status: 'complete', knownCostUsd: 1 },
    total: { status: 'unknown', knownCostUsd: null },
  });
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

test('family breakdown uses the same observed amounts and deduplication as the persisted summary', () => {
  const ledger = new RunCostLedger();
  ledger.observeChat({ callId: 'llm', pricing: { status: 'known', costUsd: 0.2 } } as never);
  const decision = {
    family: 'classifier',
    attemptIndex: 0,
    eventId: 'decision',
    classifierUsage: { estimatedCostUsd: 0.03 },
  } as never;
  ledger.observeClassifier(decision);
  ledger.observeClassifier(decision);
  ledger.observeLegacy('old-chat', 0.1);
  const costs = ledger.breakdown();
  assert.deepEqual(costs.llm, { status: 'partial', knownCostUsd: 0.2 + 0.1 });
  assert.deepEqual(costs.decisionAI, { status: 'complete', knownCostUsd: 0.03 });
  assert.deepEqual(costs.total, ledger.snapshot());
  ledger.markUnobserved();
  assert.equal(ledger.breakdown().decisionAI.status, 'partial');
  assert.equal(costs.decisionAI.status, 'complete', 'A snapshot is detached from later observations');
});

test('project scopes include descendants, isolate sibling coverage, and deduplicate once for the root', () => {
  const root = new RunCostLedger();
  const left = root.createProjectScope();
  const right = root.createProjectScope();
  const leaf = left.createProjectScope();
  root.observeChat({ callId: 'root', pricing: { status: 'known', costUsd: 0.1 } } as never);
  left.observeClassifier({
    family: 'classifier',
    attemptIndex: 0,
    eventId: 'left',
    classifierUsage: { estimatedCostUsd: 0.2 },
  } as never);
  right.observeChat({ callId: 'right', pricing: { status: 'known', costUsd: 0.9 } } as never);
  const leafCall = { callId: 'leaf', pricing: { status: 'known', costUsd: 0.3 } } as never;
  leaf.observeChat(leafCall);
  left.observeChat(leafCall);
  root.observeChat(leafCall);
  assert.deepEqual(root.snapshot(), { status: 'complete', knownCostUsd: 0.1 + 0.2 + 0.9 + 0.3 });
  assert.deepEqual(left.breakdown(), {
    llm: { status: 'complete', knownCostUsd: 0.3 },
    decisionAI: { status: 'complete', knownCostUsd: 0.2 },
    total: { status: 'complete', knownCostUsd: 0.5 },
  });
  right.markUnobserved('llm');
  assert.equal(root.snapshot().status, 'partial');
  assert.equal(left.snapshot().status, 'complete', 'Unpriced sibling calls cannot taint this subtree');
  root.markUnobserved('decisionAI');
  assert.equal(left.snapshot().status, 'complete', 'Unpriced caller work cannot taint this subtree');
  leaf.markUnobserved('decisionAI');
  assert.deepEqual(leaf.breakdown().decisionAI, { status: 'unknown', knownCostUsd: null });
  assert.deepEqual(left.breakdown().decisionAI, { status: 'partial', knownCostUsd: 0.2 });
  assert.deepEqual(right.breakdown().decisionAI, { status: 'complete', knownCostUsd: 0 });
  assert.deepEqual(
    root.createProjectScope().snapshot(),
    { status: 'complete', knownCostUsd: 0 },
    'A new call starts empty even when its parent already has costs',
  );
});

test('incremental summaries match ordered physical-call replay after every interleaved observation', () => {
  const root = new RunCostLedger();
  const left = root.createProjectScope();
  const scopes = [root, left, root.createProjectScope(), left.createProjectScope()];
  const parents = [-1, 0, 0, 1];
  const calls = new Map<string, { owner: number; family: RunCostFamily; cost: number | null }>();
  const reference = (scope: number, family?: RunCostFamily, pending = false): RunCostSnapshot => {
    let amount = 0,
      known = false,
      unknown = pending;
    for (const call of calls.values()) {
      if (family && call.family !== family) continue;
      let owner = call.owner;
      while (owner !== -1 && owner !== scope) owner = parents[owner]!;
      if (owner === -1) continue;
      if (call.cost === null) unknown = true;
      else {
        amount += call.cost;
        known = true;
      }
    }
    if (!Number.isFinite(amount) || (unknown && !known)) return { status: 'unknown', knownCostUsd: null };
    return { status: unknown ? 'partial' : 'complete', knownCostUsd: amount };
  };
  for (let i = 0; i < 250; i++) {
    const owner = i % scopes.length;
    const family: RunCostFamily = i % 3 === 0 ? 'decisionAI' : 'llm';
    const id = `physical-${i % 43}`;
    const cost = i % 11 === 0 ? undefined : i % 13 === 0 ? -1 : i % 5 === 0 ? 0 : (i % 17) / 100_000;
    if (family === 'llm')
      scopes[owner]!.observeChat({ callId: id, pricing: { status: 'known', costUsd: cost } } as never);
    else
      scopes[owner]!.observeClassifier({
        family: 'classifier',
        attemptIndex: 0,
        eventId: id,
        classifierUsage: { estimatedCostUsd: cost },
      } as never);
    const key = `${family}:${id}`;
    if (!calls.has(key)) calls.set(key, { owner, family, cost: typeof cost === 'number' && cost >= 0 ? cost : null });
    for (let scope = 0; scope < scopes.length; scope++) {
      assert.deepEqual(scopes[scope]!.breakdown(), {
        llm: reference(scope, 'llm'),
        decisionAI: reference(scope, 'decisionAI'),
        total: reference(scope),
      });
      assert.deepEqual(scopes[scope]!.snapshot(true), reference(scope, undefined, true));
    }
  }
});
