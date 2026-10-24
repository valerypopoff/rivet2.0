import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkEditorBoundaries,
  hasForbiddenExecutionImport,
  hasDirectExecutionStateWrite,
} from './check-editor-boundaries.mjs';

test('ingress/history adapters cannot bypass the shared snapshot writer', () => {
  for (const source of [
    'store.set(projectExecutionSnapshotsState, next);',
    'useSetAtom(lastRunDataByNodeState);',
    'store.set(runActivityJournalState, update);',
  ])
    assert.equal(hasDirectExecutionStateWrite(source), true, source);
  for (const source of [
    'store.get(lastRunDataByNodeState)',
    'store.set(graphRunningState, true)',
    'writer.event("nodeFinish", data)',
  ])
    assert.equal(hasDirectExecutionStateWrite(source), false, source);
});

test('execution-domain guard rejects framework, UI-state and dynamic/side-effect imports', () => {
  for (const source of [
    "import { atom } from 'jotai';",
    "import React from 'react';",
    "import 'react';",
    "import { createRoot } from 'react-dom/client';",
    "await import('react-dom');",
    "await import('jotai/utils');",
    "require('react/jsx-runtime');",
    "import { state } from '../../state/dataFlow.js';",
    "import type { Provider } from '../../providers/ProvidersContext.js';",
  ])
    assert.equal(hasForbiddenExecutionImport(source), true, source);
});

test('execution-domain guard permits public Core types and pure domain modules', () => {
  for (const source of [
    "import type { ProjectId } from '@valerypopoff/rivet2-core';",
    "import { getExecutionBundleKey } from './bundleMembership.js';",
    "import { value } from 'reactive-values';",
  ])
    assert.equal(hasForbiddenExecutionImport(source), false, source);
  assert.deepEqual(checkEditorBoundaries(), []);
});
