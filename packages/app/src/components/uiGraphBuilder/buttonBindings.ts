import {
  type GraphBoundary,
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
  return boundary ? getReconciledUiGraphActionInputBindings(component.action, boundary) : [];
}

export function getButtonOutputRows(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphOutputBinding[] {
  return boundary ? getReconciledUiGraphActionOutputBindings(component.action, boundary) : [];
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
