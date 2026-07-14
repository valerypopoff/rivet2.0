import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Project, UiGraphId } from '@valerypopoff/rivet2-core';
import { normalizeProjectSnapshot } from './projectSnapshot.js';

const uiGraphId = 'app' as UiGraphId;

void describe('hosted project snapshot normalization', () => {
  void it('repairs legacy UI component IDs before the project enters app state', () => {
    const project = makeProject();
    project.uiGraphs![uiGraphId]!.components = [{ text: 'Legacy', type: 'text' } as never];

    const normalized = normalizeProjectSnapshot({ project });

    assert.equal(normalized.project.uiGraphs?.[uiGraphId]?.components[0]?.id, 'app-component-1');
    assert.equal('id' in project.uiGraphs![uiGraphId]!.components[0]!, false);
  });

  void it('rejects malformed UI components at the hosted boundary', () => {
    const project = makeProject();
    project.uiGraphs![uiGraphId]!.components = [{ id: 'input', label: 'Input', type: 'input' } as never];

    assert.throws(() => normalizeProjectSnapshot({ project }), /UI graph "app" component at index 0\.stateKey/);
  });

  void it('keeps attached data separate without cloning already-valid UI graphs', () => {
    const project = makeProject();
    project.data = { value: { type: 'string', value: 'attached' } } as never;

    const normalized = normalizeProjectSnapshot({ project });

    assert.equal(normalized.project.uiGraphs, project.uiGraphs);
    assert.equal('data' in normalized.project, false);
    assert.equal(normalized.data, project.data);
  });
});

function makeProject(): Project {
  return {
    graphs: {},
    metadata: { description: '', id: 'project' as never, title: 'Project' },
    uiGraphs: {
      app: {
        components: [{ id: 'text' as never, text: 'Text', type: 'text' }],
        id: 'app' as never,
        name: 'App',
      },
    } as Project['uiGraphs'],
  };
}
