import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleWorkspaceTabs } from './workspaceTabs.js';

test('workspace tabs show project-independent workspaces', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: undefined,
  });

  assert.deepEqual(
    tabs.map((tab) => tab.key),
    ['trivet', 'dataStudio'],
  );
});

test('workspace tabs show active Prompt Designer only while it is open', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: 'promptDesigner',
  });

  assert.deepEqual(
    tabs.map((tab) => tab.key),
    ['trivet', 'dataStudio', 'promptDesigner'],
  );
});

test('workspace tabs show Welcome screen only in no-project mode', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: undefined,
    welcomeScreenAvailable: true,
  });

  assert.deepEqual(
    tabs.map((tab) => [tab.key, tab.targetOverlay]),
    [
      ['welcomeScreen', undefined],
      ['trivet', 'trivet'],
      ['dataStudio', 'dataStudio'],
    ],
  );
});

test('workspace tabs honor a host-provided visible-item allowlist', () => {
  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: ['dataStudio', 'trivet'] },
      openOverlay: undefined,
    }).map((tab) => tab.key),
    ['trivet', 'dataStudio'],
  );

  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: ['dataStudio'] },
      openOverlay: undefined,
      welcomeScreenAvailable: true,
    }).map((tab) => tab.key),
    ['welcomeScreen', 'dataStudio'],
  );

  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: [] },
      openOverlay: 'promptDesigner',
      welcomeScreenAvailable: true,
    }).map((tab) => tab.key),
    ['welcomeScreen', 'promptDesigner'],
  );

  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: [] },
      openOverlay: undefined,
    }),
    [],
  );
});
