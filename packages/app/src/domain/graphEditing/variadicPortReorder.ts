import type {
  ChartNode,
  NodeConnection,
  NodeId,
  NodeInputDefinition,
  NodeOutputDefinition,
  PortId,
} from '@valerypopoff/rivet2-core';

export type VariadicPortReorderKind = 'input-only' | 'input-output-pair';

export type VariadicPortReorderSpec = {
  inputPrefix: string;
  kind: VariadicPortReorderKind;
  outputPrefix?: string;
};

export type VariadicPortReorderSide = 'input' | 'output';
export type VariadicPortReorderMappings = {
  inputPortMapping?: Record<string, string>;
  outputPortMapping?: Record<string, string>;
};

export const VARIADIC_PORT_REORDER_SPECS: Partial<Record<ChartNode['type'], VariadicPortReorderSpec>> = {
  array: { inputPrefix: 'input', kind: 'input-only' },
  assembleMessage: { inputPrefix: 'part', kind: 'input-only' },
  assemblePrompt: { inputPrefix: 'message', kind: 'input-only' },
  coalesce: { inputPrefix: 'input', kind: 'input-only' },
  delay: { inputPrefix: 'input', kind: 'input-output-pair', outputPrefix: 'output' },
  didRun: { inputPrefix: 'input', kind: 'input-only' },
  join: { inputPrefix: 'input', kind: 'input-only' },
  passthrough: { inputPrefix: 'input', kind: 'input-output-pair', outputPrefix: 'output' },
  raceInputs: { inputPrefix: 'input', kind: 'input-only' },
  startBackgroundBranch: {
    inputPrefix: 'input',
    kind: 'input-output-pair',
    outputPrefix: 'output',
  },
};

export function getVariadicPortReorderSpec(node: Pick<ChartNode, 'type'>): VariadicPortReorderSpec | undefined {
  return VARIADIC_PORT_REORDER_SPECS[node.type];
}

export function getNumberedPortIndex(portId: string, prefix: string): number | undefined {
  if (!portId.startsWith(prefix)) {
    return undefined;
  }

  const rawIndex = portId.slice(prefix.length);
  if (!/^\d+$/.test(rawIndex)) {
    return undefined;
  }

  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

export function getMaxConnectedVariadicInputIndex(options: {
  connections: readonly NodeConnection[];
  inputPrefix: string;
  nodeId: NodeId;
}): number {
  let maxIndex = 0;

  for (const connection of options.connections) {
    if (connection.inputNodeId !== options.nodeId) {
      continue;
    }

    const index = getNumberedPortIndex(connection.inputId, options.inputPrefix);
    if (index && index > maxIndex) {
      maxIndex = index;
    }
  }

  return maxIndex;
}

export function getReorderableVariadicInputDefinitions(options: {
  connections: readonly NodeConnection[];
  definitions: readonly NodeInputDefinition[];
  node: ChartNode;
}): NodeInputDefinition[] {
  const spec = getVariadicPortReorderSpec(options.node);
  if (!spec) {
    return [];
  }

  const maxConnectedIndex = getMaxConnectedVariadicInputIndex({
    connections: options.connections,
    inputPrefix: spec.inputPrefix,
    nodeId: options.node.id,
  });

  if (maxConnectedIndex === 0) {
    return [];
  }

  return options.definitions.filter((definition) => {
    const index = getNumberedPortIndex(definition.id, spec.inputPrefix);
    return index != null && index <= maxConnectedIndex;
  });
}

export function getReorderableVariadicOutputDefinitions(options: {
  definitions: readonly NodeOutputDefinition[];
  inputDefinitions: readonly NodeInputDefinition[];
  spec: VariadicPortReorderSpec | undefined;
}): NodeOutputDefinition[] {
  if (!options.spec?.outputPrefix) {
    return [];
  }

  const outputDefinitionsById = new Map<string, NodeOutputDefinition>(
    options.definitions.map((definition) => [definition.id, definition]),
  );

  return options.inputDefinitions
    .map((input) => getMirroredPortId(input.id, options.spec!.inputPrefix, options.spec!.outputPrefix!))
    .map((outputId) => outputDefinitionsById.get(outputId))
    .filter((definition): definition is NodeOutputDefinition => !!definition);
}

export function canRearrangeVariadicNodePorts(options: {
  connections: readonly NodeConnection[];
  node: ChartNode | undefined;
}): VariadicPortReorderKind | undefined {
  if (!options.node) {
    return undefined;
  }

  const spec = getVariadicPortReorderSpec(options.node);
  if (!spec) {
    return undefined;
  }

  const maxConnectedIndex = getMaxConnectedVariadicInputIndex({
    connections: options.connections,
    inputPrefix: spec.inputPrefix,
    nodeId: options.node.id,
  });

  return maxConnectedIndex >= 2 ? spec.kind : undefined;
}

export function getMirroredPortId(portId: string, fromPrefix: string, toPrefix: string): string {
  const index = getNumberedPortIndex(portId, fromPrefix);
  return index == null ? portId : `${toPrefix}${index}`;
}

export function buildVariadicPortIdMapping(options: {
  currentPortOrder: readonly string[];
  nextPortOrder: readonly string[];
}): Record<string, string> {
  if (options.currentPortOrder.length !== options.nextPortOrder.length) {
    return {};
  }

  const currentIds = new Set(options.currentPortOrder);
  const nextIds = new Set(options.nextPortOrder);
  if (
    currentIds.size !== options.currentPortOrder.length ||
    nextIds.size !== options.nextPortOrder.length ||
    currentIds.size !== nextIds.size ||
    options.nextPortOrder.some((id) => !currentIds.has(id))
  ) {
    return {};
  }

  const mapping: Record<string, string> = {};
  for (const [index, sourcePortId] of options.nextPortOrder.entries()) {
    const targetPortId = options.currentPortOrder[index];
    if (targetPortId && sourcePortId !== targetPortId) {
      mapping[sourcePortId] = targetPortId;
    }
  }

  return mapping;
}

export function mapVariadicPairPortIdMapping(
  mapping: Readonly<Record<string, string>>,
  fromPrefix: string,
  toPrefix: string,
): Record<string, string> {
  const mappedPairs: Record<string, string> = {};

  for (const [sourcePortId, targetPortId] of Object.entries(mapping)) {
    mappedPairs[getMirroredPortId(sourcePortId, fromPrefix, toPrefix)] = getMirroredPortId(
      targetPortId,
      fromPrefix,
      toPrefix,
    );
  }

  return mappedPairs;
}

export function buildVariadicPortReorderMappings(options: {
  currentPortOrder: readonly string[];
  nextPortOrder: readonly string[];
  side: VariadicPortReorderSide;
  spec: VariadicPortReorderSpec;
}): VariadicPortReorderMappings | undefined {
  const primaryMapping = buildVariadicPortIdMapping({
    currentPortOrder: options.currentPortOrder,
    nextPortOrder: options.nextPortOrder,
  });

  if (Object.keys(primaryMapping).length === 0) {
    return undefined;
  }

  if (options.side === 'input') {
    return {
      inputPortMapping: primaryMapping,
      outputPortMapping:
        options.spec.kind === 'input-output-pair' && options.spec.outputPrefix
          ? mapVariadicPairPortIdMapping(primaryMapping, options.spec.inputPrefix, options.spec.outputPrefix)
          : undefined,
    };
  }

  if (!options.spec.outputPrefix) {
    return undefined;
  }

  return {
    inputPortMapping: mapVariadicPairPortIdMapping(primaryMapping, options.spec.outputPrefix, options.spec.inputPrefix),
    outputPortMapping: primaryMapping,
  };
}

export function reorderVariadicNodeConnections(options: {
  connections: readonly NodeConnection[];
  inputPortMapping?: Readonly<Record<string, string>>;
  nodeId: NodeId;
  outputPortMapping?: Readonly<Record<string, string>>;
}): NodeConnection[] {
  const inputPortMapping = options.inputPortMapping ?? {};
  const outputPortMapping = options.outputPortMapping ?? {};

  return options.connections.map((connection) => {
    const nextInputId = connection.inputNodeId === options.nodeId ? inputPortMapping[connection.inputId] : undefined;
    const nextOutputId =
      connection.outputNodeId === options.nodeId ? outputPortMapping[connection.outputId] : undefined;

    if (!nextInputId && !nextOutputId) {
      return connection;
    }

    return {
      ...connection,
      inputId: (nextInputId ?? connection.inputId) as PortId,
      outputId: (nextOutputId ?? connection.outputId) as PortId,
    };
  });
}

export function hasVariadicNodeConnectionAffectedByMapping(options: {
  connections: readonly NodeConnection[];
  inputPortMapping?: Readonly<Record<string, string>>;
  nodeId: NodeId;
  outputPortMapping?: Readonly<Record<string, string>>;
}): boolean {
  const inputPortMapping = options.inputPortMapping ?? {};
  const outputPortMapping = options.outputPortMapping ?? {};

  return options.connections.some((connection) => {
    const inputChanges =
      connection.inputNodeId === options.nodeId &&
      Object.prototype.hasOwnProperty.call(inputPortMapping, connection.inputId);
    const outputChanges =
      connection.outputNodeId === options.nodeId &&
      Object.prototype.hasOwnProperty.call(outputPortMapping, connection.outputId);

    return inputChanges || outputChanges;
  });
}
