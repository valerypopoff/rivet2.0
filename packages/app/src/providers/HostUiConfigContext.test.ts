import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRivetAppHostCapabilityEnabled,
  shouldCheckForUpdates,
  shouldPreloadCodeEditor,
} from './HostUiConfigContext.js';

test('embedded hosts retain normal startup behavior unless they explicitly disable it', () => {
  assert.equal(shouldCheckForUpdates(), true);
  assert.equal(shouldPreloadCodeEditor(), true);
  assert.equal(shouldCheckForUpdates({}), true);
  assert.equal(shouldPreloadCodeEditor({}), true);
});

test('embedded hosts can disable update checks and idle code-editor warmup independently', () => {
  assert.equal(shouldCheckForUpdates({ checkForUpdates: false }), false);
  assert.equal(shouldPreloadCodeEditor({ preloadCodeEditor: false }), false);
  assert.equal(shouldCheckForUpdates({ preloadCodeEditor: false }), true);
  assert.equal(shouldPreloadCodeEditor({ checkForUpdates: false }), true);
});

test('host capabilities remain enabled unless a host explicitly opts out', () => {
  assert.equal(isRivetAppHostCapabilityEnabled(undefined, 'aiAssist'), true);
  assert.equal(isRivetAppHostCapabilityEnabled({}, 'aiGraphBuilder'), true);
  assert.equal(isRivetAppHostCapabilityEnabled({ capabilities: { recordings: false } }, 'recordings'), false);
  assert.equal(isRivetAppHostCapabilityEnabled({ capabilities: { recordings: false } }, 'trivetInputCopy'), true);
});
