import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphId, Project, ProjectId } from '@valerypopoff/rivet2-core';
import {
  applyProjectMetadataPatch,
  hasProjectMetadataPatchChanges,
  normalizeProjectMetadataPatch,
} from './projectMetadataUpdates.js';

function makeProject(): Project {
  return {
    metadata: {
      id: 'project-1' as ProjectId,
      title: 'Project',
      description: 'Description',
      mainGraphId: 'graph-1' as GraphId,
    },
    graphs: {},
  };
}

describe('project metadata update helpers', () => {
  test('normalizes hosted metadata patches to safe fields', () => {
    const patch = normalizeProjectMetadataPatch({
      title: 'Renamed',
      description: 'Updated',
      id: 'different-project' as ProjectId,
      mainGraphId: 'different-graph' as GraphId,
    } as Parameters<typeof normalizeProjectMetadataPatch>[0]);

    assert.deepEqual(patch, {
      title: 'Renamed',
      description: 'Updated',
    });
  });

  test('treats empty runtime patch values as no-op patches', () => {
    const project = makeProject();

    assert.deepEqual(normalizeProjectMetadataPatch(undefined), {});
    assert.deepEqual(normalizeProjectMetadataPatch(null), {});
    assert.equal(hasProjectMetadataPatchChanges(project.metadata, undefined), false);
    assert.equal(applyProjectMetadataPatch(project, undefined), project);
  });

  test('applies title and description changes without changing immutable metadata', () => {
    const project = makeProject();
    const result = applyProjectMetadataPatch(project, {
      title: 'Renamed',
      description: 'Updated',
      id: 'different-project' as ProjectId,
    } as Parameters<typeof applyProjectMetadataPatch>[1]);

    assert.equal(result.metadata.id, 'project-1');
    assert.equal(result.metadata.mainGraphId, 'graph-1');
    assert.equal(result.metadata.title, 'Renamed');
    assert.equal(result.metadata.description, 'Updated');
  });

  test('keeps the same project reference when the safe fields do not change', () => {
    const project = makeProject();

    assert.equal(applyProjectMetadataPatch(project, { title: 'Project' }), project);
    assert.equal(hasProjectMetadataPatchChanges(project.metadata, { title: 'Project' }), false);
  });
});
