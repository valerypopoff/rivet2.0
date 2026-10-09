import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readWorkflowLibrarySelection,
  writeWorkflowLibrarySelection,
} from '../dashboard/workflowLibrarySelectionStorage.js';

test('sidebar selection survives remounts and path updates, and clearing removes it', (t) => {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  assert.equal(readWorkflowLibrarySelection(), '');
  writeWorkflowLibrarySelection('/workflows/Folder/Project.rivet-project');
  assert.equal(readWorkflowLibrarySelection(), '/workflows/Folder/Project.rivet-project');
  writeWorkflowLibrarySelection('/workflows/Renamed.rivet-project');
  assert.equal(readWorkflowLibrarySelection(), '/workflows/Renamed.rivet-project');
  writeWorkflowLibrarySelection('');
  assert.equal(readWorkflowLibrarySelection(), '');
  assert.equal(values.size, 0);
});

test('unavailable browser session storage does not break normal selection', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() {
      throw new Error('Storage blocked');
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  assert.equal(readWorkflowLibrarySelection(), '');
  assert.doesNotThrow(() => writeWorkflowLibrarySelection('/workflows/Test.rivet-project'));
});
