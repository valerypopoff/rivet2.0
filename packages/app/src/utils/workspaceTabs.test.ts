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
