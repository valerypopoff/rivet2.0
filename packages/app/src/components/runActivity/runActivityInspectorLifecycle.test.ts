import assert from 'node:assert/strict';
import test from 'node:test';
import type { RootRunId } from '@valerypopoff/rivet2-core';
import { shouldCloseRunActivityInspector } from './runActivityInspectorLifecycle.js';

const rootA = 'root-a' as RootRunId;
const rootB = 'root-b' as RootRunId;

test('response inspector remains open only for its selected root', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: rootA }),
    false,
  );
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: rootB }),
    true,
  );
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: true, inspectedRootRunId: rootA, selectedRootRunId: undefined }),
    true,
  );
});

test('closing the drawer always closes its response inspector', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: false, inspectedRootRunId: rootA, selectedRootRunId: rootA }),
    true,
  );
});

test('a closed drawer without an inspector does not schedule a redundant state reset', () => {
  assert.equal(
    shouldCloseRunActivityInspector({ drawerOpen: false, inspectedRootRunId: undefined, selectedRootRunId: rootA }),
    false,
  );
});
