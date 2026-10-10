import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import type { OpeningProjectTabId } from '../state/openingProjectTabs.js';
import type { KeyboardShortcutEvent } from './keyboardShortcutMatcher.js';
import type { ProjectTabListItem } from './openingProjectTabs.js';
import {
  getAdjacentProjectTab,
  getProjectTabHotkeyDirection,
  installProjectTabHotkeyListener,
  type ProjectTabHotkeyState,
} from './projectTabHotkeys.js';

const a: ProjectTabListItem = { type: 'project', projectId: 'a' as ProjectId };
const b: ProjectTabListItem = { type: 'project', projectId: 'b' as ProjectId };
const c: ProjectTabListItem = { type: 'opening', openingTabId: 'c' as OpeningProjectTabId };
const key = (code: string, modifiers: Partial<KeyboardShortcutEvent> = {}): KeyboardShortcutEvent => ({
  code,
  key: code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

test('Windows and Linux match Chrome tab navigation, not tab-reordering or extra modifiers', () => {
  for (const platform of ['windows', 'linux'] as const) {
    assert.equal(getProjectTabHotkeyDirection(key('Tab', { ctrlKey: true }), platform), 1);
    assert.equal(getProjectTabHotkeyDirection(key('Tab', { ctrlKey: true, shiftKey: true }), platform), -1);
    assert.equal(getProjectTabHotkeyDirection(key('PageDown', { ctrlKey: true }), platform), 1);
    assert.equal(getProjectTabHotkeyDirection(key('PageUp', { ctrlKey: true }), platform), -1);
    assert.equal(getProjectTabHotkeyDirection(key('PageDown', { ctrlKey: true, shiftKey: true }), platform), undefined);
    assert.equal(getProjectTabHotkeyDirection(key('PageUp', { ctrlKey: true, shiftKey: true }), platform), undefined);
    assert.equal(getProjectTabHotkeyDirection(key('Tab'), platform), undefined);
    assert.equal(getProjectTabHotkeyDirection(key('Tab', { ctrlKey: true, altKey: true }), platform), undefined);
    assert.equal(getProjectTabHotkeyDirection(key('Tab', { ctrlKey: true, metaKey: true }), platform), undefined);
    assert.equal(getProjectTabHotkeyDirection(key('Tab', { metaKey: true }), platform), undefined);
  }
});

test('macOS matches Command+Option+arrows without claiming text navigation shortcuts', () => {
  assert.equal(getProjectTabHotkeyDirection(key('ArrowRight', { metaKey: true, altKey: true }), 'macos'), 1);
  assert.equal(getProjectTabHotkeyDirection(key('ArrowLeft', { metaKey: true, altKey: true }), 'macos'), -1);
  for (const modifiers of [
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true, altKey: true },
    { metaKey: true, altKey: true, shiftKey: true },
    { metaKey: true, altKey: true, ctrlKey: true },
  ]) {
    assert.equal(getProjectTabHotkeyDirection(key('ArrowLeft', modifiers), 'macos'), undefined);
  }
  // Semantic keys work even when no physical code is provided.
  assert.equal(getProjectTabHotkeyDirection(key('', { key: 'ArrowRight', metaKey: true, altKey: true }), 'macos'), 1);
});

test('adjacent navigation follows visible order, wraps, and includes opening placeholders', () => {
  assert.equal(getAdjacentProjectTab([a, b, c], a, -1), c);
  assert.equal(getAdjacentProjectTab([a, b, c], c, 1), a);
  assert.equal(getAdjacentProjectTab([c, a, b], a, -1), c);
  assert.equal(getAdjacentProjectTab([c, a, b], a, 1), b);
  assert.equal(getAdjacentProjectTab([a, b], undefined, 1), a);
  assert.equal(getAdjacentProjectTab([a, b], undefined, -1), b);
  assert.equal(getAdjacentProjectTab([], a, 1), undefined);
  assert.equal(getAdjacentProjectTab([a], a, 1), undefined);
});

test('listener advances pending intent, yields to other selections/failures and cleans up', () => {
  const dom = new JSDOM('<input id="input">');
  let state: ProjectTabHotkeyState = {
    enabled: true,
    platform: 'windows',
    tabs: [a, b, c],
    selected: a,
    activation: { revision: 0, pending: false },
  };
  const selections: ProjectTabListItem[] = [];
  const cleanup = installProjectTabHotkeyListener(
    dom.window as unknown as Window,
    () => state,
    (tab) => {
      selections.push(tab);
      state = { ...state, activation: { revision: state.activation.revision + 1, pending: true } };
    },
  );
  const dispatch = (options: KeyboardEventInit = {}) => {
    const event = new dom.window.KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    dom.window.document.getElementById('input')!.dispatchEvent(event);
    return event;
  };
  try {
    assert.equal(dispatch().defaultPrevented, true);
    dispatch();
    assert.deepEqual(selections, [b, c]);
    // A mouse/host intent supersedes the keyboard cursor even while pending.
    state = { ...state, selected: b, activation: { revision: 3, pending: true } };
    dispatch({ shiftKey: true });
    assert.equal(selections.at(-1), a);
    // A failed activation returns navigation to the actual active tab.
    state = { ...state, selected: b, activation: { revision: 4, pending: false } };
    dispatch();
    assert.equal(selections.at(-1), c);
    state = { ...state, enabled: false };
    assert.equal(dispatch().defaultPrevented, false);
    state = { ...state, enabled: true, tabs: [a] };
    assert.equal(dispatch().defaultPrevented, false);
    state = { ...state, tabs: [a, b, c] };
    assert.equal(dispatch({ isComposing: true }).defaultPrevented, false);
    cleanup();
    assert.equal(dispatch().defaultPrevented, false);
    assert.equal(selections.length, 4);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test('listener respects an already handled event', () => {
  const dom = new JSDOM();
  const event = new dom.window.KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', ctrlKey: true, cancelable: true });
  event.preventDefault();
  const cleanup = installProjectTabHotkeyListener(
    dom.window as unknown as Window,
    () => {
      throw new Error('Handled key must not read workspace state');
    },
    () => assert.fail('Handled key must not select a tab'),
  );
  try {
    dom.window.dispatchEvent(event);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test('closing a pending keyboard target returns navigation to the live tab, not the first tab', () => {
  const dom = new JSDOM();
  let state: ProjectTabHotkeyState = {
    enabled: true,
    platform: 'windows',
    tabs: [a, b, c],
    selected: a,
    activation: { revision: 0, pending: false },
  };
  const selections: ProjectTabListItem[] = [];
  const cleanup = installProjectTabHotkeyListener(
    dom.window as unknown as Window,
    () => state,
    (tab) => {
      selections.push(tab);
      state = { ...state, activation: { revision: state.activation.revision + 1, pending: true } };
    },
  );
  const dispatch = () =>
    dom.window.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        code: 'Tab',
        key: 'Tab',
        ctrlKey: true,
        cancelable: true,
      }),
    );
  try {
    dispatch(); // Request B, but its saved snapshot is still loading.
    assert.deepEqual(selections, [b]);
    // Closing an inactive tab does not itself advance the activation revision.
    state = { ...state, tabs: [a, c] };
    dispatch();
    assert.deepEqual(selections, [b, c]);
  } finally {
    cleanup();
    dom.window.close();
  }
});
