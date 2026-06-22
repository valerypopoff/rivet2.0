import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDashboardToEditorCommand,
  isEditorToDashboardEvent,
} from '../../shared/editor-bridge';

test('open project bridge command accepts an optional preview mode flag', () => {
  assert.equal(isDashboardToEditorCommand({
    type: 'open-project',
    path: '/workflows/example.rivet-project',
    replaceCurrent: false,
    preview: true,
  }), true);
  assert.equal(isDashboardToEditorCommand({
    type: 'open-project',
    path: '/workflows/example.rivet-project',
    replaceCurrent: false,
    preview: 'true',
  }), false);
});

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
    path: '/workflows/reference.rivet-project',
    referencePath: 'reference.rivet-project',
    labels: {
      referenceLabel: 'Reference project',
      currentLabel: 'Open project',
    },
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
  assert.equal(isDashboardToEditorCommand({
    type: 'compare-open-project-with',
    path: '/workflows/reference.rivet-project',
    labels: {
      referenceLabel: 1,
    },
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

test('active project unsaved changes event validates path and dirty payload', () => {
  assert.equal(isEditorToDashboardEvent({
    type: 'active-project-unsaved-changes-changed',
    path: '/workflows/example.rivet-project',
    hasUnsavedChanges: true,
  }), true);
  assert.equal(isEditorToDashboardEvent({
    type: 'active-project-unsaved-changes-changed',
    path: '/workflows/example.rivet-project',
  }), false);
});
