import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectId } from '@valerypopoff/rivet2-core';
import {
  normalizeProjectTabUiState,
  removeProjectTabUiState,
  updateProjectTabUiState,
} from './projectTabUi.js';

describe('project tab UI state helpers', () => {
  test('normalizes only active preview tab state', () => {
    assert.deepEqual(normalizeProjectTabUiState({ preview: true }), { preview: true });
    assert.equal(normalizeProjectTabUiState({ preview: false }), undefined);
    assert.equal(normalizeProjectTabUiState({}), undefined);
    assert.equal(normalizeProjectTabUiState(undefined), undefined);
  });

  test('sets and clears preview state by project id', () => {
    const projectId = 'project-1' as ProjectId;
    const otherProjectId = 'project-2' as ProjectId;
    const current = {
      [otherProjectId]: { preview: true },
    };

    const withPreview = updateProjectTabUiState(current, projectId, { preview: true });
    assert.deepEqual(withPreview, {
      [otherProjectId]: { preview: true },
      [projectId]: { preview: true },
    });

    const withoutPreview = updateProjectTabUiState(withPreview, projectId, { preview: false });
    assert.deepEqual(withoutPreview, {
      [otherProjectId]: { preview: true },
    });
  });

  test('returns the same reference for no-op updates', () => {
    const projectId = 'project-1' as ProjectId;
    const empty = {};
    const current = {
      [projectId]: { preview: true },
    };

    assert.equal(updateProjectTabUiState(current, projectId, { preview: true }), current);
    assert.equal(removeProjectTabUiState(empty, projectId), empty);
  });

  test('removes project tab UI state when a project closes', () => {
    const projectId = 'project-1' as ProjectId;
    const otherProjectId = 'project-2' as ProjectId;

    assert.deepEqual(
      removeProjectTabUiState(
        {
          [projectId]: { preview: true },
          [otherProjectId]: { preview: true },
        },
        projectId,
      ),
      {
        [otherProjectId]: { preview: true },
      },
    );
  });
});
