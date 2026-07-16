import {
  type GraphBoundary,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  getReconciledUiGraphActionInputBindings,
  getReconciledUiGraphActionOutputBindings,
  initializeUiGraphRunGraphActionBindings,
  reconcileUiGraphRunGraphActionBindings,
  type UiGraphComponent,
  type UiGraphInputBinding,
  type UiGraphOutputBinding,
} from '@valerypopoff/rivet2-core';

export type UiGraphButtonComponent = Extract<UiGraphComponent, { type: 'button' }>;

export function normalizeButtonActionToGraphBoundary(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): void {
  if (boundary) {
    component.action = reconcileUiGraphRunGraphActionBindings(component.action, boundary);
  }
}

export function initializeButtonActionToGraphBoundary(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): void {
  if (boundary) {
    component.action = initializeUiGraphRunGraphActionBindings(component.action, boundary);
  }
}

export function getButtonInputRows(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphInputBinding[] {
  return boundary ? getPersistedInputRows(component.action, boundary) : [];
}

export function getButtonOutputRows(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphOutputBinding[] {
  return boundary ? getPersistedOutputRows(component.action, boundary) : [];
}

export function setButtonInputRows(component: UiGraphButtonComponent, rows: UiGraphInputBinding[]): void {
  component.action.inputMappings = rows;
  delete component.action.inputs;
}

export function setButtonOutputRows(component: UiGraphButtonComponent, rows: UiGraphOutputBinding[]): void {
  component.action.outputs = rows.map((row) => ({
    outputKey: row.outputKey || undefined,
    stateKey: row.stateKey,
  }));
  delete component.action.outputKey;
  delete component.action.outputStateKey;
}

export function alignInputRowsToBoundary(
  boundary: GraphBoundary,
  rows: readonly UiGraphInputBinding[],
): UiGraphInputBinding[] {
  return getReconciledUiGraphActionInputBindings({ inputMappings: [...rows], type: 'runGraph' }, boundary);
}

export function alignOutputRowsToBoundary(
  boundary: GraphBoundary,
  rows: readonly UiGraphOutputBinding[],
): UiGraphOutputBinding[] {
  return getReconciledUiGraphActionOutputBindings({ outputs: [...rows], type: 'runGraph' }, boundary);
}

/**
 * Settings rows reflect serialized bindings. Reconciliation belongs to an
 * explicit graph-boundary mutation, not a render-time default that can look
 * saved while runtime validation still sees an empty mapping.
 */
function getPersistedInputRows(
  componentAction: UiGraphButtonComponent['action'],
  boundary: GraphBoundary,
): UiGraphInputBinding[] {
  return orderPersistedBindings(
    boundary.inputs.map((input) => input.id),
    getUiGraphActionInputBindings(componentAction),
    (binding) => binding.inputKey,
  );
}

function getPersistedOutputRows(
  componentAction: UiGraphButtonComponent['action'],
  boundary: GraphBoundary,
): UiGraphOutputBinding[] {
  const bindings = getUiGraphActionOutputBindings(componentAction);
  const allOutputBindings = bindings.filter((binding) => !binding.outputKey);

  return [
    ...allOutputBindings,
    ...orderPersistedBindings(
      boundary.outputs.map((output) => output.id),
      bindings.filter((binding): binding is UiGraphOutputBinding & { outputKey: string } => Boolean(binding.outputKey)),
      (binding) => binding.outputKey,
    ),
  ];
}

function orderPersistedBindings<T>(
  boundaryIds: readonly string[],
  bindings: readonly T[],
  getId: (binding: T) => string,
): T[] {
  const bindingsById = new Map<string, T[]>();
  for (const binding of bindings) {
    const id = getId(binding);
    bindingsById.set(id, [...(bindingsById.get(id) ?? []), binding]);
  }

  const boundaryIdSet = new Set(boundaryIds);
  return [
    ...boundaryIds.flatMap((id) => bindingsById.get(id) ?? []),
    ...bindings.filter((binding) => !boundaryIdSet.has(getId(binding))),
  ];
}
