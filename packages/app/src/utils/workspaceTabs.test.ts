import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleWorkspaceTabs } from './workspaceTabs.js';

test('workspace tabs show project workspaces when a project is available', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: undefined,
  });

  assert.deepEqual(
    tabs.map((tab) => tab.key),
    ['evaluations', 'dataStudio'],
  );
});

test('workspace tabs hide project-scoped workspaces without a project', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: undefined,
    projectAvailable: false,
    welcomeScreenAvailable: true,
  });

  assert.deepEqual(
    tabs.map((tab) => tab.key),
    ['welcomeScreen'],
  );
});

test('workspace tabs show active Prompt Designer only while it is open', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: 'promptDesigner',
  });

  assert.deepEqual(
    tabs.map((tab) => tab.key),
    ['evaluations', 'dataStudio', 'promptDesigner'],
  );
});

test('workspace tabs show Welcome screen only in no-project mode', () => {
  const tabs = getVisibleWorkspaceTabs({
    openOverlay: undefined,
    projectAvailable: false,
    welcomeScreenAvailable: true,
  });

  assert.deepEqual(
    tabs.map((tab) => [tab.key, tab.targetOverlay]),
    [['welcomeScreen', undefined]],
  );
});

test('workspace tabs honor a host-provided visible-item allowlist', () => {
  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: ['dataStudio', 'evaluations'] },
      openOverlay: undefined,
    }).map((tab) => tab.key),
    ['evaluations', 'dataStudio'],
  );

  assert.deepEqual(
    getVisibleWorkspaceTabs({
      config: { visibleItems: ['dataStudio'] },
      openOverlay: undefined,
      projectAvailable: false,
      welcomeScreenAvailable: true,
    }).map((tab) => tab.key),
    ['welcomeScreen'],
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
