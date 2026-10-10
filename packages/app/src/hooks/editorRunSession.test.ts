import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorRunSession } from './editorRunSession.js';

test('cancellation during preparation reaches execution when it is bound later', async () => {
  const parent = new AbortController();
  const session = new EditorRunSession(parent.signal);
  parent.abort('closed');
  let cancellations = 0;
  session.bindCancellation(() => {
    cancellations += 1;
  });
  session.abort();
  assert.equal(cancellations, 1);
  assert.equal(session.signal.reason, 'closed');
  await session.dispose();
});

test('disposal is single flight and releases every resource even if one fails', async () => {
  const session = new EditorRunSession();
  let disposed = 0;
  session.onDispose(() => {
    throw new Error('cleanup');
  });
  session.onDispose(() => {
    disposed += 1;
  });
  const first = session.dispose();
  assert.equal(first, session.dispose());
  await assert.rejects(first, /cleanup/);
  assert.equal(disposed, 1);
});

test('a disposed session detaches parent cancellation and cannot bind new execution', async () => {
  const parent = new AbortController();
  const session = new EditorRunSession(parent.signal);
  let cancellations = 0;
  session.bindCancellation(() => {
    cancellations += 1;
  });
  await session.dispose();
  parent.abort();
  assert.equal(cancellations, 0);
  assert.equal(session.signal.aborted, false);
  assert.throws(() => session.bindCancellation(() => {}), /disposed/);
});

test('a reentrant cleanup observes the same disposal promise', async () => {
  const session = new EditorRunSession();
  let observed: Promise<void> | undefined;
  session.onDispose(() => {
    observed = session.dispose();
  });
  const disposed = session.dispose();
  await disposed;
  assert.equal(observed, disposed);
});
