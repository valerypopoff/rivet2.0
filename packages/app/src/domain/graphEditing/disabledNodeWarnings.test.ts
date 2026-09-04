import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, NodeInputDefinition, PortId } from '@valerypopoff/rivet2-core';
import { combineNodeHeaderWarnings, getDisabledUpstreamInputWarnings } from './disabledNodeWarnings.js';

function node(id: string, title: string, disabled = false, type = 'test'): ChartNode {
  return {
    id: id as NodeId,
    type,
    title,
    disabled,
    data: {},
    visualData: { x: 0, y: 0, width: 250 },
  } as ChartNode;
}

function connection(sourceId: string, targetId: string, inputId = 'required'): NodeConnection {
  return {
    outputNodeId: sourceId as NodeId,
    outputId: 'output' as PortId,
    inputNodeId: targetId as NodeId,
    inputId: inputId as PortId,
  };
}

const requiredInput: NodeInputDefinition = {
  id: 'required' as PortId,
  title: 'Required value',
  dataType: 'string',
  required: true,
};

const optionalInput: NodeInputDefinition = {
  id: 'optional' as PortId,
  title: 'Optional value',
  dataType: 'string',
};

function warningsFor({
  connections,
  nodes,
  inputDefinitionsByNodeId,
}: {
  connections: NodeConnection[];
  nodes: ChartNode[];
  inputDefinitionsByNodeId: Record<string, NodeInputDefinition[]>;
}) {
  return getDisabledUpstreamInputWarnings({
    connections,
    nodesById: Object.fromEntries(nodes.map((candidate) => [candidate.id, candidate])),
    getInputDefinitions: (nodeId) => inputDefinitionsByNodeId[nodeId] ?? [],
  });
}

test('warns an enabled node when its required input uses a disabled source', () => {
  const source = node('source', 'Disabled source', true);
  const target = node('target', 'Target');

  const warnings = warningsFor({
    connections: [connection(source.id, target.id)],
    nodes: [source, target],
    inputDefinitionsByNodeId: { [target.id]: [requiredInput] },
  });

  assert.equal(
    warnings.get(target.id),
    'Input "Required value" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
});

test('warns optional inputs that Core excludes, but not nodes that consume excluded values', () => {
  const disabledSource = node('disabled-source', 'Disabled source', true);
  const optionalTarget = node('optional-target', 'Optional target');
  const coalesceTarget = node('coalesce-target', 'Coalesce target', false, 'coalesce');

  const warnings = warningsFor({
    connections: [
      connection(disabledSource.id, optionalTarget.id, optionalInput.id),
      connection(disabledSource.id, coalesceTarget.id, optionalInput.id),
    ],
    nodes: [disabledSource, optionalTarget, coalesceTarget],
    inputDefinitionsByNodeId: {
      [optionalTarget.id]: [optionalInput],
      [coalesceTarget.id]: [optionalInput],
    },
  });

  assert.equal(
    warnings.get(optionalTarget.id),
    'Input "Optional value" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
  assert.equal(warnings.get(coalesceTarget.id), undefined);
});

test('warns a Graph Input default-value connection from a disabled source', () => {
  const disabledSource = node('disabled-source', 'Disabled source', true);
  const graphInput = node('graph-input', 'Graph Input', false, 'graphInput');
  const defaultValueInput: NodeInputDefinition = {
    id: 'default' as PortId,
    title: 'Default Value',
    dataType: 'string',
  };

  const warnings = warningsFor({
    connections: [connection(disabledSource.id, graphInput.id, defaultValueInput.id)],
    nodes: [disabledSource, graphInput],
    inputDefinitionsByNodeId: { [graphInput.id]: [defaultValueInput] },
  });

  assert.equal(
    warnings.get(graphInput.id),
    'Input "Default Value" is connected to disabled node "Disabled source". A disabled connection provides no usable value, so when running, this node will be marked Not Ran.',
  );
});

test('ignores enabled sources and disabled targets', () => {
  const disabledSource = node('disabled-source', 'Disabled source', true);
  const enabledSource = node('enabled-source', 'Enabled source');
  const enabledTarget = node('enabled-target', 'Enabled target');
  const disabledTarget = node('disabled-target', 'Disabled target', true);

  const warnings = warningsFor({
    connections: [connection(enabledSource.id, enabledTarget.id), connection(disabledSource.id, disabledTarget.id)],
    nodes: [disabledSource, enabledSource, enabledTarget, disabledTarget],
    inputDefinitionsByNodeId: {
      [enabledTarget.id]: [requiredInput],
      [disabledTarget.id]: [requiredInput],
    },
  });

  assert.deepEqual([...warnings.entries()], []);
});

test('uses the first valid wire for an input slot and ignores unknown input ports', () => {
  const disabledSource = node('disabled-source', 'Disabled source', true);
  const enabledSource = node('enabled-source', 'Enabled source');
  const target = node('target', 'Target');

  const warnings = warningsFor({
    connections: [
      connection(enabledSource.id, target.id),
      connection(disabledSource.id, target.id),
      connection(disabledSource.id, target.id, 'removed-port'),
    ],
    nodes: [disabledSource, enabledSource, target],
    inputDefinitionsByNodeId: { [target.id]: [requiredInput] },
  });

  assert.deepEqual([...warnings.entries()], []);
});

test('combines multiple dependencies and preserves existing header warnings', () => {
  const firstSource = node('first-source', 'First source', true);
  const secondSource = node('second-source', 'Second source', true);
  const target = node('target', 'Target');
  const secondInput: NodeInputDefinition = { ...requiredInput, id: 'second' as PortId, title: 'Second value' };

  const warnings = warningsFor({
    connections: [connection(firstSource.id, target.id), connection(secondSource.id, target.id, secondInput.id)],
    nodes: [firstSource, secondSource, target],
    inputDefinitionsByNodeId: { [target.id]: [requiredInput, secondInput] },
  });

  assert.equal(
    warnings.get(target.id),
    'Inputs are connected to disabled nodes: "Required value" ← "First source"; "Second value" ← "Second source". Disabled connections provide no usable values, so when running, this node will be marked Not Ran.',
  );
  assert.equal(
    combineNodeHeaderWarnings('Existing warning', warnings.get(target.id), 'Existing warning'),
    `Existing warning\n\n${warnings.get(target.id)}`,
  );
});
