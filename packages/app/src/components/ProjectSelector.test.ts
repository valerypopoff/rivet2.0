import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { getInAppMenuHotkeyCommand } from '../utils/inAppMenuHotkeys.js';
import {
  projectTabDragActivationConstraint,
  resolveOpeningProjectTabPresentation,
  resolveProjectSelectorPlatformPolicy,
  resolveProjectTabPresentation,
} from './projectSelector/projectSelectorModel.js';
import { ProjectTabSurface } from './projectSelector/ProjectTabSurface.js';

test('project tabs select after click completion while preserving close and drag behavior', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const restoreGlobals = installDomGlobals(dom);
  const root = createRoot(dom.window.document.getElementById('root')!);
  let selections = 0;
  let closes = 0;

  try {
    await act(async () =>
      root.render(
        React.createElement(ProjectTabSurface, {
          active: true,
          closeIcon: React.createElement('span', undefined, 'Close'),
          displayName: 'Project',
          dragListeners: { onPointerDown: () => undefined },
          onCloseProject: () => {
            closes += 1;
          },
          onSelectProject: () => {
            selections += 1;
          },
        }),
      ),
    );

    const project = dom.window.document.querySelector<HTMLElement>('.project')!;
    const close = dom.window.document.querySelector<HTMLButtonElement>('.close-project')!;

    await act(async () => project.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })));
    assert.equal(selections, 0);

    await act(async () => project.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(selections, 1);

    await act(async () => close.click());
    assert.equal(closes, 1);
    assert.equal(selections, 1);
    assert.deepEqual(projectTabDragActivationConstraint, { distance: 4 });
  } finally {
    await act(async () => root.unmount());
    restoreGlobals();
    dom.window.close();
  }
});

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

function installDomGlobals(dom: JSDOM): () => void {
  const keys = ['document', 'navigator', 'window', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const previousDescriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  return () => {
    for (const [key, descriptor] of previousDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
