import test from 'node:test';
import assert from 'node:assert/strict';
import { readLatestDebuggerDiagnostic } from './latestDebuggerDiagnostic.js';

test('HA diagnostic envelopes resolve bounded, nonterminal warning messages', () => {
  for (const code of ['history-truncated', 'history-gap', 'event-too-large', 'owner-unavailable']) {
    const result = readLatestDebuggerDiagnostic({ message: 'latest-diagnostic', data: { protocol: 1, code } });
    assert.equal(result?.code, code);
    assert.ok(result?.message);
  }
  for (const data of [
    null,
    {},
    { protocol: 2, code: 'history-gap' },
    { protocol: 1, code: '__proto__' },
    { protocol: 1, code: 'unknown' },
  ])
    assert.equal(readLatestDebuggerDiagnostic({ message: 'latest-diagnostic', data }), undefined);
});

test('only exact, unscoped legacy HA notices are reclassified during mixed-version upgrades', () => {
  const notice =
    'Latest debugger history has a gap. Earlier diagnostics may be unavailable; executions were not replayed.';
  assert.equal(readLatestDebuggerDiagnostic({ message: 'error', data: { error: notice } })?.code, 'history-gap');
  for (const envelope of [
    { message: 'error', data: { error: notice + ' application error' } },
    { message: 'error', requestId: 'real-run', data: { error: notice } },
    { message: 'error', data: { error: notice, execution: { rootRunId: 'real-run' } } },
    { message: 'error', data: { error: 'Real graph failure' } },
  ])
    assert.equal(readLatestDebuggerDiagnostic(envelope), undefined);
});
