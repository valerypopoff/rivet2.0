import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECORDING_INPUT_PATH_HISTORY_KEY,
  normalizeInputPathHistory,
  readInputPathHistory,
  rememberInputPath,
  deleteInputPath,
} from '../dashboard/recording-input-path-history';

test('path history trims and deduplicates without changing case-sensitive paths', () => {
  assert.deepEqual(normalizeInputPathHistory([' $.foo ', '$.foo', '$.Foo', '', null, 3]), ['$.foo', '$.Foo']);
  assert.deepEqual(normalizeInputPathHistory({ path: '$.foo' }), []);
});

test('unavailable browser storage falls back without blocking filters', () => {
  assert.deepEqual(rememberInputPath('$.foo'), ['$.foo']);
  assert.deepEqual(readInputPathHistory(), ['$.foo']);
});

test('history survives storage round trips and tolerates corrupt or denied storage', (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    denied = false;
    readInputPathHistory();
    stored.clear();
    readInputPathHistory();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const stored = new Map<string, string>();
  let denied = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem(key: string) {
          if (denied) throw new Error('Storage denied');
          return stored.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          if (denied) throw new Error('Storage denied');
          stored.set(key, value);
        },
      },
    },
  });
  // Clear any document-local fallback created by the unavailable-storage test.
  readInputPathHistory();
  stored.clear();
  assert.deepEqual(readInputPathHistory(), []);
  rememberInputPath('$.bar');
  assert.deepEqual(rememberInputPath(' $.foo '), ['$.foo', '$.bar']);
  assert.deepEqual(rememberInputPath('$.foo'), ['$.foo', '$.bar']);
  deleteInputPath('$.bar');
  assert.deepEqual(readInputPathHistory(), ['$.foo']);
  stored.set(RECORDING_INPUT_PATH_HISTORY_KEY, '{broken');
  assert.deepEqual(readInputPathHistory(), ['$.foo']);
  denied = true;
  assert.deepEqual(readInputPathHistory(), ['$.foo']);
  rememberInputPath('$.bar');
  deleteInputPath('$.foo');
  assert.deepEqual(readInputPathHistory(), ['$.bar']);
  denied = false;
  assert.deepEqual(readInputPathHistory(), ['$.bar']);
  assert.equal(stored.get(RECORDING_INPUT_PATH_HISTORY_KEY), '["$.bar"]');
  denied = true;
  assert.deepEqual(deleteInputPath('$.bar'), []);
  assert.deepEqual(readInputPathHistory(), []);
  denied = false;
  assert.deepEqual(readInputPathHistory(), []);
  assert.equal(stored.get(RECORDING_INPUT_PATH_HISTORY_KEY), '[]');
  rememberInputPath('$.base');
  denied = true;
  rememberInputPath('$.local');
  // A second tab adds a path and removes the original while our write is pending.
  stored.set(RECORDING_INPUT_PATH_HISTORY_KEY, JSON.stringify(['$.remote']));
  denied = false;
  assert.deepEqual(readInputPathHistory(), ['$.local', '$.remote']);
  denied = true;
  deleteInputPath('$.local');
  // A failed deletion must not erase an unrelated addition in a second tab.
  stored.set(RECORDING_INPUT_PATH_HISTORY_KEY, JSON.stringify(['$.new', '$.local', '$.remote']));
  denied = false;
  assert.deepEqual(readInputPathHistory(), ['$.new', '$.remote']);
});
