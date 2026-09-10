import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, GraphId, NodeGraph, NodeId, Project } from '@valerypopoff/rivet2-core';
import {
  getGlobalVariableOptions,
  getMissingKnownGlobalVariableWarning,
  getKnownGlobalVariableIds,
} from './globalVariableOptions.js';

function setGlobalNode(id: string, useIdInput = false, disabled = false): ChartNode {
  return {
    type: 'setGlobal',
    id: `set-global-${id}` as NodeId,
    title: 'Set Global',
    visualData: {
      x: 0,
      y: 0,
      width: 200,
    },
    data: {
      id,
      useIdInput,
      dataType: 'string',
    },
    disabled,
  };
}

function getGlobalNode(id: string, useIdInput = false, disabled = false): ChartNode {
  return {
    type: 'getGlobal',
    id: `get-global-${id}` as NodeId,
    title: 'Get Global',
    visualData: {
      x: 0,
      y: 0,
      width: 200,
    },
    data: {
      id,
      useIdInput,
      dataType: 'string',
    },
    disabled,
  };
}

function graph(id: string, nodes: ChartNode[]): NodeGraph {
  return {
    metadata: {
      id: id as GraphId,
      name: id,
      description: '',
    },
    nodes,
    connections: [],
  };
}

function project(
  graphs: Record<string, NodeGraph>,
  globalVariables: Project['metadata']['globalVariables'] = undefined,
): Pick<Project, 'graphs' | 'metadata'> {
  return {
    graphs,
    metadata: {
      id: 'project' as never,
      title: 'Project',
      description: '',
      globalVariables,
    },
  };
}

test('getGlobalVariableOptions returns fixed Set Global IDs from all project graphs', () => {
  assert.deepEqual(
    getGlobalVariableOptions(
      project({
        a: graph('a', [setGlobalNode('zeta'), setGlobalNode('alpha')]),
        b: graph('b', [setGlobalNode('middle')]),
      }),
    ),
    [
      { label: 'alpha', value: 'alpha' },
      { label: 'middle', value: 'middle' },
      { label: 'zeta', value: 'zeta' },
    ],
  );
});

test('getGlobalVariableOptions ignores dynamic and empty Set Global IDs', () => {
  assert.deepEqual(
    getGlobalVariableOptions(
      project({
        main: graph('main', [setGlobalNode('fixed-id'), setGlobalNode('dynamic-id', true), setGlobalNode('')]),
      }),
    ),
    [{ label: 'fixed-id', value: 'fixed-id' }],
  );
});

test('getGlobalVariableOptions deduplicates repeated fixed IDs', () => {
  assert.deepEqual(
    getGlobalVariableOptions(
      project({
        a: graph('a', [setGlobalNode('shared')]),
        b: graph('b', [setGlobalNode('shared')]),
      }),
    ),
    [{ label: 'shared', value: 'shared' }],
  );
});

test('getGlobalVariableOptions includes project and referenced project global variables', () => {
  assert.deepEqual(
    getGlobalVariableOptions(
      project(
        { main: graph('main', []) },
        { rootGlobal: { type: 'string', value: 'root' } },
      ),
      undefined,
      {
        referenced: {
          metadata: {
            id: 'referenced' as never,
            title: 'Referenced',
            description: '',
            globalVariables: { referencedGlobal: { type: 'number', value: 2 } },
          },
        },
      },
    ),
    [
      { label: 'referencedGlobal', value: 'referencedGlobal' },
      { label: 'rootGlobal', value: 'rootGlobal' },
    ],
  );
});

test('getGlobalVariableOptions prefers the live graph over the saved project graph', () => {
  assert.deepEqual(
    getGlobalVariableOptions(
      project({
        main: graph('main', [setGlobalNode('saved-id')]),
        other: graph('other', [setGlobalNode('other-id')]),
      }),
      graph('main', [setGlobalNode('live-id')]),
    ),
    [
      { label: 'live-id', value: 'live-id' },
      { label: 'other-id', value: 'other-id' },
    ],
  );
});

test('getMissingKnownGlobalVariableWarning warns when a fixed Get Global ID has no enabled known writer', () => {
  const ids = getKnownGlobalVariableIds(
    project({
      main: graph('main', [setGlobalNode('disabled-only', false, true), setGlobalNode('dynamic-id', true)]),
    }),
    undefined,
    { includeDisabled: false },
  );

  assert.equal(
    getMissingKnownGlobalVariableWarning(getGlobalNode('missing-id'), ids),
    'No enabled Set Global node or configured project global sets variable ID "missing-id".',
  );
  assert.equal(
    getMissingKnownGlobalVariableWarning(getGlobalNode('disabled-only'), ids),
    'No enabled Set Global node or configured project global sets variable ID "disabled-only".',
  );
  assert.equal(
    getMissingKnownGlobalVariableWarning(getGlobalNode('dynamic-id'), ids),
    'No enabled Set Global node or configured project global sets variable ID "dynamic-id".',
  );
});

test('getMissingKnownGlobalVariableWarning accepts matching enabled fixed setters from any project graph', () => {
  const ids = getKnownGlobalVariableIds(
    project({
      main: graph('main', [setGlobalNode('main-id')]),
      other: graph('other', [setGlobalNode('other-id')]),
    }),
    undefined,
    { includeDisabled: false },
  );

  assert.equal(getMissingKnownGlobalVariableWarning(getGlobalNode('main-id'), ids), undefined);
  assert.equal(getMissingKnownGlobalVariableWarning(getGlobalNode('other-id'), ids), undefined);
});

test('getMissingKnownGlobalVariableWarning ignores dynamic and blank Get Global IDs', () => {
  const ids = getKnownGlobalVariableIds(
    project({
      main: graph('main', []),
    }),
    undefined,
    { includeDisabled: false },
  );

  assert.equal(getMissingKnownGlobalVariableWarning(getGlobalNode('dynamic-id', true), ids), undefined);
  assert.equal(getMissingKnownGlobalVariableWarning(getGlobalNode(''), ids), undefined);
  assert.equal(getMissingKnownGlobalVariableWarning(getGlobalNode('disabled-id', false, true), ids), undefined);
});

test('getKnownGlobalVariableIds overlays the live graph for warnings', () => {
  const ids = getKnownGlobalVariableIds(
    project({
      main: graph('main', [setGlobalNode('saved-id')]),
      other: graph('other', [setGlobalNode('other-id')]),
    }),
    graph('main', [setGlobalNode('live-id')]),
    { includeDisabled: false },
  );

  assert.deepEqual([...ids].sort(), ['live-id', 'other-id']);
});
