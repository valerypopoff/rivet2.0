import assert from 'node:assert/strict';
import test from 'node:test';
import { getActionBarRunButtonPresentation } from './actionBarRunButtons.js';

const DEFAULT_OPTIONS = {
  currentGraphName: 'Current graph',
  graphRunning: false,
  hasLoadedRecording: false,
  hasMainGraph: false,
  isMainGraph: false,
  showRunButton: true,
};

test('main graph selected uses one project-level run button', () => {
  assert.deepEqual(
    getActionBarRunButtonPresentation({
      ...DEFAULT_OPTIONS,
      hasMainGraph: true,
      isMainGraph: true,
    }),
    {
      currentGraphRunLabel: 'Run project',
      currentGraphRunSecondary: false,
      projectGraphRunLabel: 'Run project',
      showProjectGraphRunButton: false,
    },
  );
});
test('non-main graph selected shows a selected-graph run button plus Run project', () => {
  assert.deepEqual(
    getActionBarRunButtonPresentation({
      ...DEFAULT_OPTIONS,
      currentGraphName: 'Draft graph',
      hasMainGraph: true,
    }),
    {
      currentGraphRunLabel: 'Run Draft graph',
      currentGraphRunSecondary: true,
      projectGraphRunLabel: 'Run project',
      showProjectGraphRunButton: true,
    },
  );
});

test('selected-graph secondary styling uses the same condition as the project run button', () => {
  for (const options of [{ hasLoadedRecording: true }, { graphRunning: true }, { showRunButton: false }]) {
    const presentation = getActionBarRunButtonPresentation({
      ...DEFAULT_OPTIONS,
      ...options,
      hasMainGraph: true,
    });

    assert.equal(presentation.showProjectGraphRunButton, false);
    assert.equal(presentation.currentGraphRunSecondary, presentation.showProjectGraphRunButton);
  }
});

test('no main graph configured preserves the existing single Run label', () => {
  assert.deepEqual(getActionBarRunButtonPresentation(DEFAULT_OPTIONS), {
    currentGraphRunLabel: 'Run',
    currentGraphRunSecondary: false,
    projectGraphRunLabel: 'Run project',
    showProjectGraphRunButton: false,
  });
});
