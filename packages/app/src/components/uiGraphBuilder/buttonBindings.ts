import {
  type GraphBoundary,
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  type UiGraphComponent,
  type UiGraphInputBinding,
  type UiGraphOutputBinding,
} from '@valerypopoff/rivet2-core';

export type UiGraphButtonComponent = Extract<UiGraphComponent, { type: 'button' }>;

export function normalizeButtonActionToGraphBoundary(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): void {
  const currentInputRows = getUiGraphActionInputBindings(component.action);
  const currentOutputRows = getUiGraphActionOutputBindings(component.action);
  const nextInputRows = boundary ? alignInputRowsToBoundary(boundary, currentInputRows) : [];
  const nextOutputRows = boundary ? alignOutputRowsToBoundary(boundary, currentOutputRows) : [];

  if (component.action.inputs || !areInputRowsEqual(currentInputRows, nextInputRows)) {
    setButtonInputRows(component, nextInputRows);
  }

  if (
    component.action.outputKey ||
    component.action.outputStateKey ||
    !areOutputRowsEqual(currentOutputRows, nextOutputRows)
  ) {
    setButtonOutputRows(component, nextOutputRows);
  }
}

export function getButtonInputRows(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphInputBinding[] {
  return boundary ? alignInputRowsToBoundary(boundary, getUiGraphActionInputBindings(component.action)) : [];
}

export function getButtonOutputRows(
  component: UiGraphButtonComponent,
  boundary: GraphBoundary | undefined,
): UiGraphOutputBinding[] {
  return boundary ? alignOutputRowsToBoundary(boundary, getUiGraphActionOutputBindings(component.action)) : [];
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
  return boundary.inputs.map((input, index) => {
    const matchingRow = rows.find((row) => row.inputKey === input.id);
    const existingRow = matchingRow ?? rows[index];

    return {
      inputKey: matchingRow ? matchingRow.inputKey : input.id,
      stateKey: existingRow?.stateKey || input.id,
    };
  });
}

export function alignOutputRowsToBoundary(
  boundary: GraphBoundary,
  rows: readonly UiGraphOutputBinding[],
): UiGraphOutputBinding[] {
  return boundary.outputs.map((output, index) => {
    const matchingRow = rows.find((row) => row.outputKey === output.id);
    const existingRow = matchingRow ?? rows[index];

    return {
      outputKey: matchingRow ? matchingRow.outputKey : output.id,
      stateKey: existingRow?.stateKey || output.id,
    };
  });
}

export function areInputRowsEqual(
  left: readonly UiGraphInputBinding[],
  right: readonly UiGraphInputBinding[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => row.inputKey === right[index]?.inputKey && row.stateKey === right[index]?.stateKey)
  );
}

export function areOutputRowsEqual(
  left: readonly UiGraphOutputBinding[],
  right: readonly UiGraphOutputBinding[],
): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => row.outputKey === right[index]?.outputKey && row.stateKey === right[index]?.stateKey)
  );
}
