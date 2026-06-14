import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDashboardToEditorCommand,
  isEditorToDashboardEvent,
} from '../../shared/editor-bridge';

test('project compare bridge command validates required path fields', () => {
  assert.equal(isDashboardToEditorCommand({
    type: 'compare-open-project-with',
    path: '/workflows/reference.rivet-project',
  }), true);
  assert.equal(isDashboardToEditorCommand({
    type: 'compare-open-project-with',
    path: '/workflows/reference.rivet-project',
    referencePath: 'reference.rivet-project',
  }), true);
  assert.equal(isDashboardToEditorCommand({
    type: 'compare-open-project-with',
    referencePath: 'reference.rivet-project',
  }), false);
  assert.equal(isDashboardToEditorCommand({
    type: 'compare-open-project-with',
    path: '/workflows/reference.rivet-project',
    referencePath: 1,
  }), false);
});

test('project compare failure event validates path and error payloads', () => {
  assert.equal(isEditorToDashboardEvent({
    type: 'project-compare-failed',
    path: '/workflows/reference.rivet-project',
    error: 'Failed to load project',
  }), true);
  assert.equal(isEditorToDashboardEvent({
    type: 'project-compare-failed',
    path: '/workflows/reference.rivet-project',
  }), false);
});
