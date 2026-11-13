import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutorReliableInbox,
  ExecutorReliableOutbox,
  executorDeliveryPolicy,
  EXECUTOR_TRANSFER_TIMEOUT_MS,
} from '../../src/model/ExecutorSessionProtocol.js';

test('reliable chunks preserve Unicode and a lost receipt cannot repeat consumption', () => {
  const outbox = new ExecutorReliableOutbox();
  const inbox = new ExecutorReliableInbox();
  const payload = JSON.stringify({ output: ('x'.repeat(8191) + '😀\nλ').repeat(30) });
  const id = outbox.add(payload);
  let result: string | undefined;
  for (let part = outbox.next(); part; part = outbox.next()) {
    assert.ok(new TextEncoder().encode(JSON.stringify(part)).length < 64 * 1024);
    result = inbox.receive(part)?.text ?? result;
  }
  assert.equal(result, payload);
  outbox.replay();
  const first = outbox.next()!;
  assert.deepEqual(inbox.receive(first), { id });
  outbox.acknowledge(id);
  assert.equal(outbox.bytes, 0);
  assert.equal(outbox.size, 0);
});

test('partial transfers are discarded on transport loss; invalid frames and premature receipts are rejected', () => {
  const outbox = new ExecutorReliableOutbox();
  const inbox = new ExecutorReliableInbox();
  const id = outbox.add('a'.repeat(20000));
  const first = outbox.next()!;
  inbox.receive(first);
  assert.throws(() => outbox.acknowledge(id));
  inbox.resetTransfer();
  assert.throws(() => inbox.receive(outbox.next()));
  inbox.resetTransfer();
  outbox.replay();
  let text: string | undefined;
  for (let frame = outbox.next(); frame; frame = outbox.next()) text = inbox.receive(frame)?.text ?? text;
  assert.equal(text?.length, 20000);
  for (const value of [
    null,
    {},
    { id: 1, index: 0, count: Infinity, text: '' },
    { id: 1, index: -1, count: 1, text: '' },
  ])
    assert.throws(() => inbox.receive(value));
  const small = new ExecutorReliableOutbox(10);
  assert.throws(() => small.add('large enough'));
  assert.equal(small.bytes, 0);
  outbox.clear();
  inbox.clear();
  assert.equal(outbox.size, 0);
});

test('incomplete transfers expire without extending their deadline on each chunk', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let expired = 0;
  const inbox = new ExecutorReliableInbox(() => expired++);
  const outbox = new ExecutorReliableOutbox();
  outbox.add('x'.repeat(40000));
  inbox.receive(outbox.next());
  t.mock.timers.tick(EXECUTOR_TRANSFER_TIMEOUT_MS - 1);
  inbox.receive(outbox.next());
  t.mock.timers.tick(1);
  assert.equal(expired, 1);
  outbox.replay();
  let received: string | undefined;
  for (let frame = outbox.next(); frame; frame = outbox.next()) received = inbox.receive(frame)?.text ?? received;
  assert.equal(received, 'x'.repeat(40000));
});

test('result capacity covers messages above 64 MiB and policies cannot silently classify new events', () => {
  const outbox = new ExecutorReliableOutbox();
  const id = outbox.add('x'.repeat(65 * 1024 * 1024));
  assert.ok(id > 0);
  assert.equal(outbox.bytes, 65 * 1024 * 1024);
  outbox.clear();
  assert.equal(executorDeliveryPolicy('userInput'), 'reliable');
  assert.equal(executorDeliveryPolicy('pause'), 'reliable');
  assert.equal(executorDeliveryPolicy('partialOutput'), 'diagnostic');
  assert.throws(() => executorDeliveryPolicy('a-new-event'), /invalid-transfer/);
});

test('concurrent incomplete transfers share a budget and release it on reset, completion and expiry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = { bytes: 0, maxBytes: 30_000 };
  const first = new ExecutorReliableInbox(undefined, budget);
  const second = new ExecutorReliableInbox(undefined, budget);
  const firstOut = new ExecutorReliableOutbox(),
    secondOut = new ExecutorReliableOutbox();
  firstOut.add('a'.repeat(20_000));
  secondOut.add('b'.repeat(16_000));
  first.receive(firstOut.next());
  assert.equal(budget.bytes, 20_000);
  const frame = secondOut.next()!;
  assert.throws(() => second.receive(frame), /retention-limit/);
  assert.equal(budget.bytes, 20_000);
  first.resetTransfer();
  assert.equal(budget.bytes, 0);
  second.receive(frame);
  assert.equal(budget.bytes, 16_000);
  while (true) {
    const part = secondOut.next();
    if (!part) break;
    second.receive(part);
  }
  assert.equal(budget.bytes, 0);
  firstOut.replay();
  first.receive(firstOut.next());
  t.mock.timers.tick(EXECUTOR_TRANSFER_TIMEOUT_MS);
  assert.equal(budget.bytes, 0);
});
