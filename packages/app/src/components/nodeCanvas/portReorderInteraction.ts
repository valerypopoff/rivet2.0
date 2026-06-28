import type { NodeInputDefinition, NodeOutputDefinition, PortId } from '@valerypopoff/rivet2-core';
import {
  getDefinitionPortIds,
  moveSubGraphPortIdToIndexInOrder,
  normalizeSubGraphPortOrder,
  type SubGraphPortOrderSide,
} from '../../domain/graphEditing/subGraphPortOrder.js';
import type { VariadicPortReorderSide } from '../../domain/graphEditing/variadicPortReorder.js';

export type ReorderablePortDefinition = NodeInputDefinition | NodeOutputDefinition;

export type PortReorderDrag = {
  clientX: number;
  clientY: number;
  height: number;
  mode: 'subGraph' | 'variadic';
  portId: PortId;
  pointerOffsetX: number;
  pointerOffsetY: number;
  side: SubGraphPortOrderSide | VariadicPortReorderSide;
  title: string;
  width: number;
};

export type PortReorderElementSnapshot = {
  portId: string;
  top: number;
  height: number;
};

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function getOrderedPortDefinitions<T extends ReorderablePortDefinition>(
  definitions: readonly T[],
  portOrder: readonly string[] | undefined,
): T[] {
  const definitionsById = new Map<string, T>(definitions.map((definition) => [definition.id, definition]));

  return normalizeSubGraphPortOrder(getDefinitionPortIds(definitions), portOrder)
    .map((id) => definitionsById.get(id))
    .filter((definition): definition is T => !!definition);
}

export function applyOrderedDefinitionSubset<T extends ReorderablePortDefinition>(
  definitions: readonly T[],
  orderedSubset: readonly T[],
): T[] {
  const definitionIds = new Set(definitions.map((definition) => definition.id));
  const existingOrderedSubset = orderedSubset.filter((definition) => definitionIds.has(definition.id));

  if (!existingOrderedSubset.length) {
    return [...definitions];
  }

  const subsetIds = new Set(existingOrderedSubset.map((definition) => definition.id));
  const nextDefinitions: T[] = [];
  let insertedSubset = false;

  for (const definition of definitions) {
    if (!subsetIds.has(definition.id)) {
      nextDefinitions.push(definition);
      continue;
    }

    if (!insertedSubset) {
      nextDefinitions.push(...existingOrderedSubset);
      insertedSubset = true;
    }
  }

  return nextDefinitions;
}

export function getPortOrderFromElementSnapshots({
  clientY,
  portElements,
  portIds,
  portOrder,
  sourcePortId,
}: {
  clientY: number;
  portElements: readonly PortReorderElementSnapshot[];
  portIds: readonly string[];
  portOrder: readonly string[] | undefined;
  sourcePortId: PortId;
}): string[] | undefined {
  if (!portElements.length) {
    return undefined;
  }

  let insertionIndex = portElements.length;

  for (const [index, element] of portElements.entries()) {
    if (clientY < element.top + element.height / 2) {
      insertionIndex = index;
      break;
    }
  }

  const sourceIndex = portElements.findIndex((element) => element.portId === sourcePortId);
  if (sourceIndex < 0) {
    return undefined;
  }

  const targetIndex = insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex;

  return moveSubGraphPortIdToIndexInOrder({
    portIds,
    portOrder,
    sourcePortId,
    targetIndex,
  });
}

export function getPortOrderFromPoint({
  clientY,
  nodeId,
  portIds,
  portOrder,
  side,
  sourcePortId,
}: {
  clientY: number;
  nodeId: string;
  portIds: readonly string[];
  portOrder: readonly string[] | undefined;
  side: SubGraphPortOrderSide | VariadicPortReorderSide;
  sourcePortId: PortId;
}): string[] | undefined {
  const portElements = Array.from(document.querySelectorAll<HTMLElement>('[data-reorder-nodeid][data-reorder-portid]'))
    .filter((element) => element.dataset.reorderNodeid === nodeId && element.dataset.reorderPortside === side)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        portId: element.dataset.reorderPortid!,
        top: rect.top,
        height: rect.height,
      };
    });

  return getPortOrderFromElementSnapshots({
    clientY,
    portElements,
    portIds,
    portOrder,
    sourcePortId,
  });
}
