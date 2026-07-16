import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import {
  type GraphId,
  type Project,
  type ProjectId,
  type UiComponentId,
  type UiGraph,
  type UiGraphId,
} from '@valerypopoff/rivet2-core';
import { useCallback, useState } from 'react';
import { useUiGraphBuilderController } from './useUiGraphBuilderController.js';

test('builder controller owns selection, confirmed deletion, keyboard deletion, and insertion', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.test/' });
  const previousGlobals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    window: globalThis.window,
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    window: { configurable: true, value: dom.window },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const project = makeProject();
  const initialUiGraph = project.uiGraphs!['app' as UiGraphId]!;
  let latest!: {
    controller: ReturnType<typeof useUiGraphBuilderController>;
    replaceUiGraph(uiGraph: UiGraph): void;
    uiGraph: UiGraph;
  };

  const Harness = () => {
    const [uiGraph, setUiGraph] = useState(initialUiGraph);
    const updateUiGraph = useCallback((updater: (draft: UiGraph) => void) => {
      setUiGraph((current) => {
        const draft = structuredClone(current);
        updater(draft);
        return draft;
      });
    }, []);
    const controller = useUiGraphBuilderController({ project, uiGraph, updateUiGraph });
    latest = { controller, replaceUiGraph: setUiGraph, uiGraph };
    return null;
  };

  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(<Harness />));
    const initialComponentId = initialUiGraph.components[0]!.id;

    await act(async () => latest.controller.activateSettingsComponent(initialComponentId));
    assert.deepEqual([...latest.controller.selectedComponentIdSet], [initialComponentId]);

    const deleteEvent = new dom.window.KeyboardEvent('keydown', { cancelable: true, code: 'Delete' });
    await act(async () => dom.window.dispatchEvent(deleteEvent));
    assert.equal(deleteEvent.defaultPrevented, true);
    assert.deepEqual(latest.controller.pendingDeleteComponentIds, [initialComponentId]);

    await act(async () => latest.controller.confirmDeleteComponents());
    assert.equal(latest.uiGraph.components.length, 0);
    assert.equal(latest.controller.selectedComponentIdSet.size, 0);

    await act(async () => latest.controller.addComponent('markdown'));
    assert.equal(latest.uiGraph.components[0]?.type, 'markdown');
    assert.deepEqual([...latest.controller.selectedComponentIdSet], [latest.uiGraph.components[0]?.id]);

    const externallyRemovedId = latest.uiGraph.components[0]!.id;
    await act(async () => latest.controller.requestDeleteComponents([externallyRemovedId]));
    await act(async () => latest.replaceUiGraph({ ...latest.uiGraph, components: [] }));
    assert.equal(latest.controller.selectedComponentIdSet.size, 0);
    assert.deepEqual(latest.controller.pendingDeleteComponentIds, []);

    await act(async () => latest.controller.addComponent('text'));
    const replacementId = latest.uiGraph.components[0]!.id;
    const secondDeleteEvent = new dom.window.KeyboardEvent('keydown', { cancelable: true, code: 'Delete' });
    await act(async () => dom.window.dispatchEvent(secondDeleteEvent));
    assert.equal(secondDeleteEvent.defaultPrevented, true);
    assert.deepEqual(latest.controller.pendingDeleteComponentIds, [replacementId]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: previousGlobals.document },
      HTMLElement: { configurable: true, value: previousGlobals.HTMLElement },
      window: { configurable: true, value: previousGlobals.window },
    });
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

function makeProject(): Project {
  const graphId = 'main' as GraphId;
  const uiGraphId = 'app' as UiGraphId;
  return {
    graphs: {
      [graphId]: {
        connections: [],
        metadata: { description: '', id: graphId, name: 'Main' },
        nodes: [],
      },
    },
    metadata: {
      description: '',
      id: 'project' as ProjectId,
      mainGraphId: graphId,
      title: 'Project',
    },
    uiGraphs: {
      [uiGraphId]: {
        components: [{ id: 'text' as UiComponentId, text: 'Hello', type: 'text' }],
        id: uiGraphId,
        name: 'App',
      },
    },
  };
}
