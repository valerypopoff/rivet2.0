import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLocalProjectExecutorMode,
  projectExecutorModesEqual,
  resolveCurrentProjectExecutorMode,
  sanitizeProjectExecutorMode,
} from './projectExecutorMode.js';

test('resolveCurrentProjectExecutorMode stores external debugger target urls as project mode', () => {
  assert.deepEqual(
    resolveCurrentProjectExecutorMode({
      selectedExecutor: 'browser',
      target: {
        type: 'external-debugger',
        url: 'ws://debugger.example',
      },
    }),
    {
      type: 'remote-debugger',
      url: 'ws://debugger.example',
    },
  );

  assert.deepEqual(
    resolveCurrentProjectExecutorMode({
      selectedExecutor: 'browser',
      target: {
        type: 'external-debugger',
        url: '  ws://debugger.example/trimmed  ',
      },
    }),
    {
      type: 'remote-debugger',
      url: 'ws://debugger.example/trimmed',
    },
  );
});

test('resolveCurrentProjectExecutorMode stores Browser and Node as local project modes', () => {
  assert.deepEqual(
    resolveCurrentProjectExecutorMode({
      selectedExecutor: 'browser',
      target: null,
    }),
    createLocalProjectExecutorMode('browser'),
  );

  assert.deepEqual(
    resolveCurrentProjectExecutorMode({
      selectedExecutor: 'nodejs',
      target: {
        type: 'internal-desktop',
        url: 'ws://127.0.0.1:21889/internal',
      },
    }),
    createLocalProjectExecutorMode('nodejs'),
  );
});

test('sanitizeProjectExecutorMode accepts valid stored values and rejects malformed ones', () => {
  assert.deepEqual(sanitizeProjectExecutorMode({ type: 'local', executor: 'browser' }), {
    type: 'local',
    executor: 'browser',
  });
  assert.deepEqual(sanitizeProjectExecutorMode({ type: 'local', executor: 'nodejs' }), {
    type: 'local',
    executor: 'nodejs',
  });
  assert.deepEqual(sanitizeProjectExecutorMode({ type: 'remote-debugger', url: 'ws://debugger.example' }), {
    type: 'remote-debugger',
    url: 'ws://debugger.example',
  });
  assert.deepEqual(
    sanitizeProjectExecutorMode({ type: 'remote-debugger', url: '  ws://debugger.example/trimmed  ' }),
    {
      type: 'remote-debugger',
      url: 'ws://debugger.example/trimmed',
    },
  );
  assert.deepEqual(sanitizeProjectExecutorMode({ type: 'remote-debugger', url: '' }), {
    type: 'remote-debugger',
    url: 'ws://localhost:21888',
  });
  assert.equal(sanitizeProjectExecutorMode({ type: 'local', executor: 'bad' }), undefined);
  assert.equal(sanitizeProjectExecutorMode({ type: 'bad-mode' }), undefined);
  assert.equal(sanitizeProjectExecutorMode(null), undefined);
});

test('projectExecutorModesEqual compares local executors and remote debugger urls', () => {
  assert.equal(
    projectExecutorModesEqual(
      { type: 'local', executor: 'browser' },
      { type: 'local', executor: 'browser' },
    ),
    true,
  );
  assert.equal(
    projectExecutorModesEqual(
      { type: 'local', executor: 'browser' },
      { type: 'local', executor: 'nodejs' },
    ),
    false,
  );
  assert.equal(
    projectExecutorModesEqual(
      { type: 'remote-debugger', url: 'ws://a.example' },
      { type: 'remote-debugger', url: 'ws://a.example' },
    ),
    true,
  );
  assert.equal(
    projectExecutorModesEqual(
      { type: 'remote-debugger', url: 'ws://a.example' },
      { type: 'remote-debugger', url: 'ws://b.example' },
    ),
    false,
  );
  assert.equal(projectExecutorModesEqual(undefined, undefined), true);
  assert.equal(projectExecutorModesEqual(undefined, { type: 'local', executor: 'browser' }), false);
});
