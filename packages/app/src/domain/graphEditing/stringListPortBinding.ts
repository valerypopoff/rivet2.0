import {
  type ChartNode,
  type NodeConnection,
  type NodeId,
  type PortId,
  type StringListPortBinding,
  buildLegacyOrderedPortIds,
  hasValidStoredOrderedPortIds,
  sanitizeIdentifierPortValue,
} from '@valerypopoff/rivet2-core';
import { nanoid } from 'nanoid/non-secure';

export type EditableStringListRow = {
  uiId: string;
  value: string;
};

type ValueDerivedPortRow = {
  uiId: string;
  portId?: PortId;
};

type PrepareStringListPortBindingEditOptions<T extends ChartNode> = {
  node: T;
  dataKey: string;
  portBinding: StringListPortBinding<T>;
  previousRows: readonly EditableStringListRow[];
  nextRows: readonly EditableStringListRow[];
  connections: readonly NodeConnection[];
  recoverableConnections?: readonly NodeConnection[];
};

type PrepareStringListPortBindingEditResult<T extends ChartNode> = {
  nextNode: T;
  nextConnections: NodeConnection[];
  nextRecoverableConnections: NodeConnection[];
};

type StoredStableIdStringListPortBinding<T extends ChartNode> = Extract<
  StringListPortBinding<T>,
  {
    identity: 'stored-stable-id';
  }
>;

type PortBindingSide = 'input' | 'output';

type ValueDerivedStringListPortBinding<T extends ChartNode> = Extract<
  StringListPortBinding<T>,
  {
    identity: 'value-derived';
  }
>;

export function createEditableStringListRows(values: readonly string[]): EditableStringListRow[] {
  return values.map(createEditableStringListRow);
}

export function createEditableStringListRow(value: string): EditableStringListRow {
  return {
    uiId: nanoid(),
    value,
  };
}

export function reconcileEditableStringListRows(
  previousRows: readonly EditableStringListRow[],
  nextValues: readonly string[],
): EditableStringListRow[] {
  if (
    previousRows.length === nextValues.length &&
    previousRows.every((row, index) => row.value === nextValues[index])
  ) {
    return [...previousRows];
  }

  return nextValues.map((value, index) => ({
    uiId: previousRows[index]?.uiId ?? nanoid(),
    value,
  }));
}

export function moveEditableStringListRows(
  rows: readonly EditableStringListRow[],
  activeUiId: string,
  overUiId: string,
): EditableStringListRow[] {
  const oldIndex = rows.findIndex((row) => row.uiId === activeUiId);
  const newIndex = rows.findIndex((row) => row.uiId === overUiId);

  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return [...rows];
  }

  return moveListItem(rows, oldIndex, newIndex);
}

export function getEditableStringListValues(rows: readonly EditableStringListRow[]): string[] {
  return rows.map((row) => row.value);
}

export function resolveValueDerivedPortRows(rows: readonly EditableStringListRow[]): ValueDerivedPortRow[] {
  const seen = new Set<string>();

  return rows.map((row) => {
    const sanitizedPortId = sanitizeIdentifierPortValue(row.value);

    if (!sanitizedPortId || seen.has(sanitizedPortId)) {
      return {
        uiId: row.uiId,
      };
    }

    seen.add(sanitizedPortId);

    return {
      uiId: row.uiId,
      portId: sanitizedPortId as PortId,
    };
  });
}

export function prepareStringListPortBindingEdit<T extends ChartNode>({
  node,
  dataKey,
  portBinding,
  previousRows,
  nextRows,
  connections,
  recoverableConnections = [],
}: PrepareStringListPortBindingEditOptions<T>): PrepareStringListPortBindingEditResult<T> {
  if (portBinding.identity === 'stored-stable-id') {
    return prepareStoredStableIdPortBindingEdit({
      node,
      dataKey,
      portBinding,
      previousRows,
      nextRows,
      connections,
      recoverableConnections,
    });
  }

  return prepareValueDerivedPortBindingEdit({
    node,
    dataKey,
    portBinding,
    previousRows,
    nextRows,
    connections,
    recoverableConnections,
  });
}

function prepareStoredStableIdPortBindingEdit<T extends ChartNode>({
  node,
  dataKey,
  portBinding,
  previousRows,
  nextRows,
  connections,
  recoverableConnections = [],
}: Omit<PrepareStringListPortBindingEditOptions<T>, 'portBinding'> & {
  portBinding: StoredStableIdStringListPortBinding<T>;
}): PrepareStringListPortBindingEditResult<T> {
  const nextValues = getEditableStringListValues(nextRows);
  const currentData = node.data as Record<string, unknown>;
  const storedPortIdDataKey = String(portBinding.idDataKey);
  const storedPortIds = currentData[storedPortIdDataKey] as string[] | undefined;
  const hasStoredPortIds = hasValidStoredOrderedPortIds(previousRows.length, storedPortIds);
  const previousStablePortIds = hasStoredPortIds ? [...storedPortIds] : previousRows.map(() => nanoid());
  const previousRuntimePortIds = hasStoredPortIds
    ? previousStablePortIds
    : buildLegacyOrderedPortIds(previousRows.length, portBinding.legacyPortIdPattern);
  const previousStablePortIdByUiId = new Map(
    previousRows.map((row, index) => [row.uiId, previousStablePortIds[index]!] as const),
  );
  const survivingUiIds = new Set(nextRows.map((row) => row.uiId));
  const nextStablePortIds = nextRows.map((row) => previousStablePortIdByUiId.get(row.uiId) ?? nanoid());
  const remappedPortIds = new Map<string, string>();
  const removedPortIds = new Set<string>();

  previousRows.forEach((row, index) => {
    const previousRuntimePortId = previousRuntimePortIds[index]!;

    if (survivingUiIds.has(row.uiId)) {
      const nextStablePortId = previousStablePortIdByUiId.get(row.uiId)!;
      addStoredStablePortBindingRemap({
        remappedPortIds,
        previousPortId: previousRuntimePortId,
        nextPortId: nextStablePortId,
        portBinding,
      });
    } else {
      addStoredStablePortBindingRemoval({
        removedPortIds,
        portId: previousRuntimePortId,
        portBinding,
      });
    }
  });

  return {
    nextNode: {
      ...node,
      data: {
        ...currentData,
        [dataKey]: nextValues,
        [storedPortIdDataKey]: nextStablePortIds,
      },
    } as T,
    nextConnections: remapConnectionsForStoredStablePortBinding({
      nodeId: node.id,
      portBinding,
      connections,
      remappedPortIds,
      removedPortIds,
    }),
    nextRecoverableConnections: remapConnectionsForStoredStablePortBinding({
      nodeId: node.id,
      portBinding,
      connections: recoverableConnections,
      remappedPortIds,
      removedPortIds,
    }),
  };
}

function addStoredStablePortBindingRemap<T extends ChartNode>({
  remappedPortIds,
  previousPortId,
  nextPortId,
  portBinding,
}: {
  remappedPortIds: Map<string, string>;
  previousPortId: string;
  nextPortId: string;
  portBinding: StoredStableIdStringListPortBinding<T>;
}): void {
  remappedPortIds.set(previousPortId, nextPortId);

  for (const companionBinding of portBinding.companionBindings ?? []) {
    remappedPortIds.set(
      `${companionBinding.prefix ?? ''}${previousPortId}${companionBinding.suffix ?? ''}`,
      `${companionBinding.prefix ?? ''}${nextPortId}${companionBinding.suffix ?? ''}`,
    );
  }
}

function addStoredStablePortBindingRemoval<T extends ChartNode>({
  removedPortIds,
  portId,
  portBinding,
}: {
  removedPortIds: Set<string>;
  portId: string;
  portBinding: StoredStableIdStringListPortBinding<T>;
}): void {
  removedPortIds.add(portId);

  for (const companionBinding of portBinding.companionBindings ?? []) {
    removedPortIds.add(`${companionBinding.prefix ?? ''}${portId}${companionBinding.suffix ?? ''}`);
  }
}

function remapConnectionsForStoredStablePortBinding<T extends ChartNode>({
  nodeId,
  portBinding,
  connections,
  remappedPortIds,
  removedPortIds,
}: {
  nodeId: NodeId;
  portBinding: StoredStableIdStringListPortBinding<T>;
  connections: readonly NodeConnection[];
  remappedPortIds: ReadonlyMap<string, string>;
  removedPortIds: ReadonlySet<string>;
}): NodeConnection[] {
  const bindings: { side: PortBindingSide }[] = [{ side: portBinding.side }, ...(portBinding.companionBindings ?? [])];

  return bindings.reduce(
    (nextConnections, binding) =>
      remapConnectionsForPortBinding({
        nodeId,
        side: binding.side,
        connections: nextConnections,
        remappedPortIds,
        removedPortIds,
      }),
    [...connections],
  );
}

function prepareValueDerivedPortBindingEdit<T extends ChartNode>({
  node,
  dataKey,
  portBinding,
  previousRows,
  nextRows,
  connections,
  recoverableConnections = [],
}: Omit<PrepareStringListPortBindingEditOptions<T>, 'portBinding'> & {
  portBinding: ValueDerivedStringListPortBinding<T>;
}): PrepareStringListPortBindingEditResult<T> {
  const nextValues = getEditableStringListValues(nextRows);
  const currentData = node.data as Record<string, unknown>;
  const previousPortRows = resolveValueDerivedPortRows(previousRows);
  const nextPortRows = resolveValueDerivedPortRows(nextRows);
  const nextPortIdByUiId = new Map(nextPortRows.map((row) => [row.uiId, row.portId] as const));
  const survivingUiIds = new Set(nextRows.map((row) => row.uiId));
  const remappedPortIds = new Map<string, string>();
  const removedPortIds = new Set<string>();

  previousPortRows.forEach((previousRow) => {
    if (!previousRow.portId) {
      return;
    }

    if (!survivingUiIds.has(previousRow.uiId)) {
      removedPortIds.add(previousRow.portId);
      return;
    }

    const nextPortId = nextPortIdByUiId.get(previousRow.uiId);
    if (!nextPortId) {
      removedPortIds.add(previousRow.portId);
      return;
    }

    remappedPortIds.set(previousRow.portId, nextPortId);
  });

  return {
    nextNode: {
      ...node,
      data: {
        ...currentData,
        [dataKey]: nextValues,
      },
    } as T,
    nextConnections: remapConnectionsForPortBinding({
      nodeId: node.id,
      side: portBinding.side,
      connections,
      remappedPortIds,
      removedPortIds,
    }),
    nextRecoverableConnections: remapConnectionsForPortBinding({
      nodeId: node.id,
      side: portBinding.side,
      connections: recoverableConnections,
      remappedPortIds,
      removedPortIds,
    }),
  };
}

function remapConnectionsForPortBinding({
  nodeId,
  side,
  connections,
  remappedPortIds,
  removedPortIds,
}: {
  nodeId: NodeId;
  side: 'input' | 'output';
  connections: readonly NodeConnection[];
  remappedPortIds: ReadonlyMap<string, string>;
  removedPortIds: ReadonlySet<string>;
}): NodeConnection[] {
  return connections.flatMap((connection) => {
    const isIncidentConnection =
      side === 'input' ? connection.inputNodeId === nodeId : connection.outputNodeId === nodeId;

    if (!isIncidentConnection) {
      return [connection];
    }

    const currentPortId = side === 'input' ? connection.inputId : connection.outputId;

    if (removedPortIds.has(currentPortId)) {
      return [];
    }

    const remappedPortId = remappedPortIds.get(currentPortId);
    if (!remappedPortId || remappedPortId === currentPortId) {
      return [connection];
    }

    return [
      side === 'input'
        ? {
            ...connection,
            inputId: remappedPortId as PortId,
          }
        : {
            ...connection,
            outputId: remappedPortId as PortId,
          },
    ];
  });
}

function moveListItem<T>(items: readonly T[], oldIndex: number, newIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(oldIndex, 1);

  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(newIndex, 0, movedItem);
  return nextItems;
}
