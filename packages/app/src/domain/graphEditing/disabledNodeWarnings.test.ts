import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartNode, NodeConnection, NodeId, NodeInputDefinition, PortId } from '@valerypopoff/rivet2-core';
import { combineNodeHeaderWarnings, getDisabledRequiredInputWarnings } from './disabledNodeWarnings.js';

function node(id: string, title: string, disabled = false): ChartNode {
  return {
    id: id as NodeId,
    type: 'test',
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
  return getDisabledRequiredInputWarnings({
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
    'Required input "Required value" is connected to disabled node "Disabled source". It will not provide a value, so this node is marked Not Ran. Enable the source or remove or replace the connection.',
  );
});

test('ignores optional inputs, enabled sources, and disabled targets', () => {
  const disabledSource = node('disabled-source', 'Disabled source', true);
  const enabledSource = node('enabled-source', 'Enabled source');
  const optionalTarget = node('optional-target', 'Optional target');
  const enabledTarget = node('enabled-target', 'Enabled target');
  const disabledTarget = node('disabled-target', 'Disabled target', true);

  const warnings = warningsFor({
    connections: [
      connection(disabledSource.id, optionalTarget.id, optionalInput.id),
      connection(enabledSource.id, enabledTarget.id),
      connection(disabledSource.id, disabledTarget.id),
    ],
    nodes: [disabledSource, enabledSource, optionalTarget, enabledTarget, disabledTarget],
    inputDefinitionsByNodeId: {
      [optionalTarget.id]: [optionalInput],
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
    connections: [
      connection(firstSource.id, target.id),
      connection(secondSource.id, target.id, secondInput.id),
    ],
    nodes: [firstSource, secondSource, target],
    inputDefinitionsByNodeId: { [target.id]: [requiredInput, secondInput] },
  });

  assert.equal(
    warnings.get(target.id),
    'Required inputs are connected to disabled nodes: "Required value" ← "First source"; "Second value" ← "Second source". They will not provide values, so this node is marked Not Ran. Enable the sources or remove or replace the connections.',
  );
  assert.equal(
    combineNodeHeaderWarnings('Existing warning', warnings.get(target.id), 'Existing warning'),
    `Existing warning\n\n${warnings.get(target.id)}`,
  );
});
