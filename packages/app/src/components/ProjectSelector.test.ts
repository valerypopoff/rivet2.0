import assert from 'node:assert/strict';
import test from 'node:test';
import { getInAppMenuHotkeyCommand } from '../utils/inAppMenuHotkeys.js';
import {
  resolveOpeningProjectTabPresentation,
  resolveProjectSelectorPlatformPolicy,
  resolveProjectTabPresentation,
} from './projectSelector/projectSelectorModel.js';

test('project tab presentation owns active labels, unsaved state, and preview styling', () => {
  assert.deepEqual(
    resolveProjectTabPresentation({
      title: 'Current project',
      fsPath: 'C:\\projects\\current.rivet-project',
      current: true,
      projectTabsSelected: true,
      openingTabSelected: false,
      preview: true,
    }),
    {
      active: true,
      displayName: 'Current project [current.rivet-project]',
      preview: true,
      unsaved: false,
    },
  );

  assert.deepEqual(
    resolveProjectTabPresentation({
      title: 'Draft',
      current: false,
      projectTabsSelected: true,
      openingTabSelected: false,
    }),
    { active: false, displayName: 'Draft', preview: false, unsaved: true },
  );
});

test('opening project tabs use their path only while active', () => {
  assert.equal(
    resolveOpeningProjectTabPresentation({
      title: 'Loading',
      path: '/projects/loading.rivet-project',
      projectTabsSelected: true,
      selected: true,
    }).displayName,
    'Loading [loading.rivet-project]',
  );
  assert.equal(
    resolveOpeningProjectTabPresentation({
      title: 'Loading',
      path: '/projects/loading.rivet-project',
      projectTabsSelected: true,
      selected: false,
    }).displayName,
    'Loading',
  );
});

test('project selector platform policy keeps native desktop controls OS-specific', () => {
  assert.deepEqual(resolveProjectSelectorPlatformPolicy({ inTauri: true, macOS: false, windows: true }), {
    showFileMenu: true,
    showWindowsWindowControls: true,
  });
  assert.deepEqual(resolveProjectSelectorPlatformPolicy({ inTauri: true, macOS: true, windows: false }), {
    showFileMenu: true,
    showWindowsWindowControls: false,
  });
  assert.deepEqual(resolveProjectSelectorPlatformPolicy({ inTauri: true, macOS: false, windows: false }), {
    showFileMenu: false,
    showWindowsWindowControls: false,
  });
});

test('save hotkey follows Ctrl on Windows and Cmd on macOS', () => {
  const base = { altKey: false, code: 'KeyS', key: 's', shiftKey: false };
  assert.equal(getInAppMenuHotkeyCommand({ ...base, ctrlKey: true, metaKey: false }, 'windows'), 'save_project');
  assert.equal(getInAppMenuHotkeyCommand({ ...base, ctrlKey: false, metaKey: true }, 'macos'), 'save_project');
  assert.equal(getInAppMenuHotkeyCommand({ ...base, ctrlKey: true, metaKey: false }, 'macos'), undefined);
});
