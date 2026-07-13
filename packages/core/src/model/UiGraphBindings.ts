import { getGraphBoundary, type GraphBoundary } from './GraphBoundaryCache.js';
import type { GraphId, NodeGraph } from './NodeGraph.js';
import type { ChartNode } from './NodeBase.js';
import type { Project } from './Project.js';
import {
  getUiGraphActionInputBindings,
  getUiGraphActionOutputBindings,
  type UiComponentId,
  type UiGraph,
  type UiGraphChatRunGraphAction,
  type UiGraphComponent,
  type UiGraphId,
  type UiGraphInputBinding,
  type UiGraphOutputBinding,
  type UiGraphRunGraphAction,
  type UiGraphValueBinding,
} from './UiGraph.js';

export type UiGraphButtonBindingRenames = {
  inputIds?: Readonly<Record<string, string>>;
  outputIds?: Readonly<Record<string, string>>;
};

export type UiGraphActionBindingIssue = {
  code:
    | 'duplicate-chat-input'
    | 'duplicate-input-binding'
    | 'duplicate-output-state-key'
    | 'empty-input-id'
    | 'empty-input-state-key'
    | 'empty-output-state-key'
    | 'missing-chat-history-input'
    | 'missing-chat-response-output'
    | 'missing-chat-user-input'
    | 'missing-target-graph'
    | 'stale-input-binding'
    | 'stale-output-binding'
    | 'target-graph-not-found';
  componentId: UiComponentId;
  graphId?: GraphId;
  message: string;
  portId?: string;
  severity: 'error';
  uiGraphId: UiGraphId;
};

/** @deprecated Use UiGraphActionBindingIssue for Button and Chat components. */
export type UiGraphButtonBindingIssue = UiGraphActionBindingIssue;

type UiGraphButtonComponent = Extract<UiGraphComponent, { type: 'button' }>;
type UiGraphChatComponent = Extract<UiGraphComponent, { type: 'chat' }>;
type BindingIssueContext = Pick<UiGraphActionBindingIssue, 'componentId' | 'graphId' | 'uiGraphId'>;
type GraphBoundaryChange = {
  boundary: GraphBoundary;
  inputsChanged: boolean;
  outputsChanged: boolean;
  previousBoundary?: GraphBoundary;
  renames: UiGraphButtonBindingRenames;
};
type BindingReconciliationOptions = {
  inputs?: { addMissing: boolean };
  outputs?: { addMissing: boolean };
};

const CHAT_HISTORY_INPUT_PATTERN = /(?:history|conversation|messages)/i;
const CHAT_USER_INPUT_PATTERN = /(?:user|prompt|question|message|input)/i;

/**
 * Aligns a button with a graph boundary without guessing by row position.
 * Exact IDs win; state keys cross an ID change only for a proven node rename.
 */
export function reconcileUiGraphRunGraphActionBindings(
  action: UiGraphRunGraphAction,
  boundary: GraphBoundary,
  renames: UiGraphButtonBindingRenames = {},
): UiGraphRunGraphAction {
  return reconcileActionBindings(action, boundary, renames, {
    inputs: { addMissing: true },
    outputs: { addMissing: true },
  });
}

function reconcileActionBindings(
  action: UiGraphRunGraphAction,
  boundary: GraphBoundary,
  renames: UiGraphButtonBindingRenames,
  options: BindingReconciliationOptions,
): UiGraphRunGraphAction {
  let nextAction = action;
  const getEditableAction = () => {
    if (nextAction === action) {
      nextAction = { ...action };
    }
    return nextAction;
  };

  if (options.inputs) {
    if (action.inputMappings) {
      const editableAction = getEditableAction();
      editableAction.inputMappings = alignInputMappings(
        boundary,
        action.inputMappings,
        renames.inputIds,
        options.inputs.addMissing,
      );
      delete editableAction.inputs;
    } else if (action.inputs) {
      const editableAction = getEditableAction();
      if (Object.values(action.inputs).every((binding) => binding.type === 'state')) {
        editableAction.inputMappings = alignInputMappings(
          boundary,
          getUiGraphActionInputBindings(action),
          renames.inputIds,
          options.inputs.addMissing,
        );
        delete editableAction.inputs;
      } else {
        editableAction.inputs = alignLegacyInputs(boundary, action.inputs, renames.inputIds, options.inputs.addMissing);
        delete editableAction.inputMappings;
      }
    } else if (options.inputs.addMissing && boundary.inputs.length > 0) {
      getEditableAction().inputMappings = alignInputMappings(boundary, [], renames.inputIds, true);
    }
  }

  if (options.outputs) {
    const currentOutputs = getUiGraphActionOutputBindings(action);
    if (currentOutputs.length > 0 || (options.outputs.addMissing && boundary.outputs.length > 0)) {
      const editableAction = getEditableAction();
      editableAction.outputs = alignOutputMappings(
        boundary,
        currentOutputs,
        renames.outputIds,
        options.outputs.addMissing,
      );
      delete editableAction.outputKey;
      delete editableAction.outputStateKey;
    }
  }

  return nextAction;
}

/** Seeds a new button from ordered factory placeholder data keys. */
export function initializeUiGraphRunGraphActionBindings(
  action: UiGraphRunGraphAction,
  boundary: GraphBoundary,
): UiGraphRunGraphAction {
  const inputSeeds = getUiGraphActionInputBindings(action);
  const outputSeeds = getUiGraphActionOutputBindings(action);
  const outputStateKeys = new Set<string>();
  const nextAction: UiGraphRunGraphAction = {
    ...action,
    inputMappings: boundary.inputs.map((input, index) => ({
      inputKey: input.id,
      stateKey: inputSeeds[index]?.stateKey || input.id,
    })),
    outputs: boundary.outputs.map((output, index) => ({
      outputKey: output.id,
      stateKey: createUniqueStateKey(outputSeeds[index]?.stateKey || output.id, outputStateKeys),
    })),
  };
  delete nextAction.inputs;
  delete nextAction.outputKey;
  delete nextAction.outputStateKey;
  return nextAction;
}

/** Seeds the three graph-boundary roles required by a new Chat component. */
export function initializeUiGraphChatActionBindings(
  action: UiGraphChatRunGraphAction,
  boundary: GraphBoundary | undefined,
): UiGraphChatRunGraphAction {
  const historyInput =
    boundary?.inputs.find((input) => input.dataType === 'chat-message[]') ??
    boundary?.inputs.find((input) => CHAT_HISTORY_INPUT_PATTERN.test(input.id)) ??
    boundary?.inputs[1];
  const userInputCandidates = boundary?.inputs.filter((input) => input.id !== historyInput?.id) ?? [];
  const userInput =
    userInputCandidates.find(
      (input) => CHAT_USER_INPUT_PATTERN.test(input.id) && !CHAT_HISTORY_INPUT_PATTERN.test(input.id),
    ) ??
    userInputCandidates.find((input) => !CHAT_HISTORY_INPUT_PATTERN.test(input.id)) ??
    userInputCandidates[0];

  return {
    ...action,
    userInputId: userInput?.id,
    historyInputId: historyInput?.id,
    responseOutputId: boundary?.outputs[0]?.id,
  };
}

export function reconcileUiGraphChatActionBindings(
  action: UiGraphChatRunGraphAction,
  boundary: GraphBoundary,
  renames: UiGraphButtonBindingRenames = {},
  changed: { inputs: boolean; outputs: boolean } = { inputs: true, outputs: true },
): UiGraphChatRunGraphAction {
  const userInputId = changed.inputs
    ? reconcileBoundaryId(action.userInputId, boundary.inputs, renames.inputIds)
    : action.userInputId;
  const historyInputId = changed.inputs
    ? reconcileBoundaryId(action.historyInputId, boundary.inputs, renames.inputIds)
    : action.historyInputId;
  const responseOutputId = changed.outputs
    ? reconcileBoundaryId(action.responseOutputId, boundary.outputs, renames.outputIds)
    : action.responseOutputId;
  const inputMappings =
    changed.inputs && action.inputMappings
      ? reconcileChatAdditionalInputMappings(boundary, action.inputMappings, renames.inputIds)
      : action.inputMappings;

  return userInputId === action.userInputId &&
    historyInputId === action.historyInputId &&
    responseOutputId === action.responseOutputId &&
    inputMappings === action.inputMappings
    ? action
    : { ...action, userInputId, historyInputId, responseOutputId, inputMappings };
}

export function getReconciledUiGraphActionInputBindings(
  action: UiGraphRunGraphAction,
  boundary: GraphBoundary,
): UiGraphInputBinding[] {
  return getUiGraphActionInputBindings(reconcileUiGraphRunGraphActionBindings(action, boundary));
}

export function getReconciledUiGraphActionOutputBindings(
  action: UiGraphRunGraphAction,
  boundary: GraphBoundary,
): UiGraphOutputBinding[] {
  return getUiGraphActionOutputBindings(reconcileUiGraphRunGraphActionBindings(action, boundary));
}

/** Reconciles workflow-bound UI components for changed graph boundaries. */
export function reconcileProjectUiGraphBindings<TProject extends Project>(
  previousProject: TProject,
  nextProject: TProject,
): TProject {
  if (!nextProject.uiGraphs) {
    return nextProject;
  }

  const changes = new Map<GraphId, GraphBoundaryChange | undefined>();
  let uiGraphs: NonNullable<Project['uiGraphs']> | undefined;

  for (const [uiGraphId, uiGraph] of Object.entries(nextProject.uiGraphs) as Array<[UiGraphId, UiGraph]>) {
    let components: UiGraphComponent[] | undefined;

    uiGraph.components.forEach((component, index) => {
      if (
        (component.type !== 'button' && component.type !== 'chat') ||
        !component.action.graphId ||
        (component.type === 'button' && hasAmbiguousUiGraphButtonBindings(component.action))
      ) {
        return;
      }

      const graphId = component.action.graphId;
      if (!changes.has(graphId)) {
        changes.set(graphId, getGraphBoundaryChange(previousProject, nextProject, graphId));
      }

      const change = changes.get(graphId);
      if (!change) {
        return;
      }

      const action =
        component.type === 'button'
          ? reconcileActionBindings(component.action, change.boundary, change.renames, {
              inputs: change.inputsChanged
                ? { addMissing: hasCompleteInputCoverage(component.action, change.previousBoundary) }
                : undefined,
              outputs: change.outputsChanged
                ? { addMissing: hasCompleteOutputCoverage(component.action, change.previousBoundary) }
                : undefined,
            })
          : reconcileUiGraphChatActionBindings(component.action, change.boundary, change.renames, {
              inputs: change.inputsChanged,
              outputs: change.outputsChanged,
            });
      if (action === component.action) {
        return;
      }

      components ??= [...uiGraph.components];
      components[index] = {
        ...component,
        action,
      };
    });

    if (components) {
      uiGraphs ??= { ...nextProject.uiGraphs };
      uiGraphs[uiGraphId] = { ...uiGraph, components };
    }
  }

  return uiGraphs ? ({ ...nextProject, uiGraphs } as TProject) : nextProject;
}

/** @deprecated Use reconcileProjectUiGraphBindings for all workflow-bound components. */
export const reconcileProjectUiGraphButtonBindings = reconcileProjectUiGraphBindings;

/** Non-mutating preflight for desktop and hosted web-app runners. */
export function validateUiGraphActionBindings(
  project: Project,
  uiGraph: UiGraph,
  componentId?: UiComponentId,
): UiGraphActionBindingIssue[] {
  return uiGraph.components.flatMap((component) => {
    if (componentId && component.id !== componentId) {
      return [];
    }
    if (component.type === 'button') {
      return validateButtonBindings(project, uiGraph.id, component);
    }
    if (component.type === 'chat') {
      return validateChatBindings(project, uiGraph.id, component);
    }
    return [];
  });
}

export function validateUiGraphButtonBindings(
  project: Project,
  uiGraph: UiGraph,
  componentId?: UiComponentId,
): UiGraphButtonBindingIssue[] {
  return uiGraph.components.flatMap((component) => {
    if (component.type !== 'button' || (componentId && component.id !== componentId)) {
      return [];
    }
    return validateButtonBindings(project, uiGraph.id, component);
  });
}

export function validateProjectUiGraphButtonBindings(project: Project): UiGraphButtonBindingIssue[] {
  return Object.values(project.uiGraphs ?? {}).flatMap((uiGraph) => validateUiGraphButtonBindings(project, uiGraph));
}

export function validateProjectUiGraphActionBindings(project: Project): UiGraphActionBindingIssue[] {
  return Object.values(project.uiGraphs ?? {}).flatMap((uiGraph) => validateUiGraphActionBindings(project, uiGraph));
}

export function formatUiGraphActionBindingIssues(issues: readonly UiGraphActionBindingIssue[]): string {
  return issues.map((issue) => issue.message).join(' ');
}

export function formatUiGraphButtonBindingIssues(issues: readonly UiGraphButtonBindingIssue[]): string {
  return formatUiGraphActionBindingIssues(issues);
}

function validateButtonBindings(
  project: Project,
  uiGraphId: UiGraphId,
  component: UiGraphButtonComponent,
): UiGraphButtonBindingIssue[] {
  const graphId = component.action.graphId;
  const context = { componentId: component.id, graphId, uiGraphId };
  if (!graphId) {
    return [createIssue(context, 'missing-target-graph', 'The button has no target graph.')];
  }

  const boundary = getGraphBoundary(project, graphId);
  if (!boundary) {
    return [createIssue(context, 'target-graph-not-found', `The button target graph "${graphId}" does not exist.`)];
  }

  return [
    ...validateInputBindings(context, component, boundary),
    ...validateOutputBindings(context, component, boundary),
  ];
}

function validateChatBindings(
  project: Project,
  uiGraphId: UiGraphId,
  component: UiGraphChatComponent,
): UiGraphActionBindingIssue[] {
  const graphId = component.action.graphId;
  const context = { componentId: component.id, graphId, uiGraphId };
  if (!graphId) {
    return [createIssue(context, 'missing-target-graph', 'The Chat component has no target graph.')];
  }

  const boundary = getGraphBoundary(project, graphId);
  if (!boundary) {
    return [
      createIssue(context, 'target-graph-not-found', `The Chat component target graph "${graphId}" does not exist.`),
    ];
  }

  const issues: UiGraphActionBindingIssue[] = [];
  const inputIds = new Set(boundary.inputs.map((input) => input.id));
  const outputIds = new Set(boundary.outputs.map((output) => output.id));
  validateChatPort(
    issues,
    context,
    component.action.userInputId,
    inputIds,
    'missing-chat-user-input',
    'user message input',
    'input',
  );
  validateChatPort(
    issues,
    context,
    component.action.historyInputId,
    inputIds,
    'missing-chat-history-input',
    'conversation history input',
    'input',
  );
  validateChatPort(
    issues,
    context,
    component.action.responseOutputId,
    outputIds,
    'missing-chat-response-output',
    'assistant response output',
    'output',
  );
  if (
    component.action.userInputId &&
    component.action.historyInputId &&
    component.action.userInputId === component.action.historyInputId
  ) {
    issues.push(
      createIssue(
        context,
        'duplicate-chat-input',
        'The Chat user message and conversation history must use different graph inputs.',
        component.action.userInputId,
      ),
    );
  }
  validateChatAdditionalInputs(issues, context, component, inputIds);
  return issues;
}

function validateChatAdditionalInputs(
  issues: UiGraphActionBindingIssue[],
  context: BindingIssueContext,
  component: UiGraphChatComponent,
  availableIds: ReadonlySet<string>,
): void {
  const seenIds = new Set([component.action.userInputId, component.action.historyInputId].filter(Boolean));
  for (const binding of component.action.inputMappings ?? []) {
    const hasInputKey = binding.inputKey.trim().length > 0;
    if (!hasInputKey) {
      issues.push(createIssue(context, 'empty-input-id', 'A Chat additional input has an empty graph input ID.'));
    } else if (seenIds.has(binding.inputKey)) {
      issues.push(
        createIssue(
          context,
          'duplicate-input-binding',
          `Graph input "${binding.inputKey}" is used more than once by the Chat component.`,
          binding.inputKey,
        ),
      );
    } else if (!availableIds.has(binding.inputKey)) {
      issues.push(
        createIssue(
          context,
          'stale-input-binding',
          `The Chat additional input "${binding.inputKey}" no longer exists.`,
          binding.inputKey,
        ),
      );
    }
    if (hasInputKey) {
      seenIds.add(binding.inputKey);
    }
    if (!binding.stateKey.trim()) {
      issues.push(
        createIssue(
          context,
          'empty-input-state-key',
          hasInputKey
            ? `Chat graph input "${binding.inputKey}" has no data key to send.`
            : 'A Chat additional input has no data key to send.',
          binding.inputKey,
        ),
      );
    }
  }
}

function validateChatPort(
  issues: UiGraphActionBindingIssue[],
  context: BindingIssueContext,
  portId: string | undefined,
  availableIds: ReadonlySet<string>,
  missingCode: 'missing-chat-user-input' | 'missing-chat-history-input' | 'missing-chat-response-output',
  label: string,
  portKind: 'input' | 'output',
): void {
  if (!portId) {
    issues.push(createIssue(context, missingCode, `The Chat component has no ${label}.`));
  } else if (!availableIds.has(portId)) {
    issues.push(
      createIssue(
        context,
        portKind === 'input' ? 'stale-input-binding' : 'stale-output-binding',
        `The Chat ${label} "${portId}" no longer exists.`,
        portId,
      ),
    );
  }
}

function validateInputBindings(
  context: BindingIssueContext,
  component: UiGraphButtonComponent,
  boundary: GraphBoundary,
): UiGraphButtonBindingIssue[] {
  const issues: UiGraphButtonBindingIssue[] = [];
  const boundaryIds = new Set(boundary.inputs.map((input) => input.id));
  const seenIds = new Set<string>();

  for (const binding of getUiGraphActionInputBindings(component.action)) {
    if (!binding.inputKey.trim()) {
      issues.push(createIssue(context, 'empty-input-id', 'A graph input mapping has an empty input ID.'));
      continue;
    }
    if (seenIds.has(binding.inputKey)) {
      issues.push(
        createIssue(
          context,
          'duplicate-input-binding',
          `Graph input "${binding.inputKey}" is mapped more than once.`,
          binding.inputKey,
        ),
      );
      continue;
    }

    seenIds.add(binding.inputKey);
    if (!boundaryIds.has(binding.inputKey)) {
      issues.push(
        createIssue(
          context,
          'stale-input-binding',
          `Graph input "${binding.inputKey}" no longer exists.`,
          binding.inputKey,
        ),
      );
    }

    const legacyBinding = component.action.inputs?.[binding.inputKey];
    const hasEmptyStateKey = component.action.inputMappings
      ? !binding.stateKey.trim()
      : legacyBinding?.type === 'state' && !legacyBinding.key.trim();
    if (hasEmptyStateKey) {
      issues.push(
        createIssue(
          context,
          'empty-input-state-key',
          `Graph input "${binding.inputKey}" has no data key to send.`,
          binding.inputKey,
        ),
      );
    }
  }

  return issues;
}

function validateOutputBindings(
  context: BindingIssueContext,
  component: UiGraphButtonComponent,
  boundary: GraphBoundary,
): UiGraphButtonBindingIssue[] {
  const issues: UiGraphButtonBindingIssue[] = [];
  const boundaryIds = new Set(boundary.outputs.map((output) => output.id));
  const stateKeys = new Set<string>();

  for (const binding of getUiGraphActionOutputBindings(component.action)) {
    const stateKey = binding.stateKey.trim();
    if (!stateKey) {
      issues.push(
        createIssue(
          context,
          'empty-output-state-key',
          `Graph output "${binding.outputKey ?? 'All outputs'}" has no data key to save to.`,
          binding.outputKey,
        ),
      );
    } else if (stateKeys.has(stateKey)) {
      issues.push(
        createIssue(
          context,
          'duplicate-output-state-key',
          `Data key "${stateKey}" is written by more than one graph output mapping.`,
          binding.outputKey,
        ),
      );
    } else {
      stateKeys.add(stateKey);
    }

    if (binding.outputKey && !boundaryIds.has(binding.outputKey)) {
      issues.push(
        createIssue(
          context,
          'stale-output-binding',
          `Graph output "${binding.outputKey}" no longer exists.`,
          binding.outputKey,
        ),
      );
    }
  }

  return issues;
}

function createIssue(
  context: BindingIssueContext,
  code: UiGraphActionBindingIssue['code'],
  message: string,
  portId?: string,
): UiGraphActionBindingIssue {
  return { ...context, code, message, portId, severity: 'error' };
}

function alignInputMappings(
  boundary: GraphBoundary,
  bindings: readonly UiGraphInputBinding[],
  renames: Readonly<Record<string, string>> | undefined,
  addMissing: boolean,
): UiGraphInputBinding[] {
  const findBinding = createBindingLookup(bindings, (binding) => binding.inputKey, renames);
  return boundary.inputs.flatMap((input) => {
    const binding = findBinding(input.id);
    return binding || addMissing ? [{ inputKey: input.id, stateKey: binding?.stateKey || input.id }] : [];
  });
}

function reconcileChatAdditionalInputMappings(
  boundary: GraphBoundary,
  bindings: readonly UiGraphInputBinding[],
  renames: Readonly<Record<string, string>> | undefined,
): UiGraphInputBinding[] {
  return bindings.map((binding) => {
    if (!binding.inputKey.trim()) {
      return binding;
    }
    const inputKey = reconcileBoundaryId(binding.inputKey, boundary.inputs, renames) ?? '';
    return inputKey === binding.inputKey ? binding : { ...binding, inputKey };
  });
}

function alignLegacyInputs(
  boundary: GraphBoundary,
  bindings: Readonly<Record<string, UiGraphValueBinding>>,
  renames: Readonly<Record<string, string>> | undefined,
  addMissing: boolean,
): Record<string, UiGraphValueBinding> {
  const findBinding = createBindingLookup(Object.entries(bindings), ([id]) => id, renames);
  return Object.fromEntries(
    boundary.inputs.flatMap((input) => {
      const binding = findBinding(input.id)?.[1];
      return binding || addMissing ? [[input.id, binding ?? { type: 'state', key: input.id }]] : [];
    }),
  );
}

function alignOutputMappings(
  boundary: GraphBoundary,
  bindings: readonly UiGraphOutputBinding[],
  renames: Readonly<Record<string, string>> | undefined,
  addMissing: boolean,
): UiGraphOutputBinding[] {
  const allOutputBindings = bindings
    .filter((binding) => !binding.outputKey)
    .map((binding) => ({ ...binding, outputKey: undefined }));
  const findBindings = createBindingListLookup(bindings, (binding) => binding.outputKey, renames);
  const matchedBindings = boundary.outputs.map((output) => findBindings(output.id));
  const usedStateKeys = new Set(
    [...allOutputBindings, ...matchedBindings.flat()].map((binding) => binding.stateKey).filter(Boolean),
  );
  const specificBindings = boundary.outputs.flatMap((output, index) => {
    const matches = matchedBindings[index]!;
    if (matches.length > 0) {
      return matches.map((binding) => {
        const stateKey = binding.stateKey || createUniqueStateKey(output.id, usedStateKeys);
        usedStateKeys.add(stateKey);
        return { outputKey: output.id, stateKey };
      });
    }
    return allOutputBindings.length > 0 || !addMissing
      ? []
      : [{ outputKey: output.id, stateKey: createUniqueStateKey(output.id, usedStateKeys) }];
  });
  return [...allOutputBindings, ...specificBindings];
}

function createUniqueStateKey(preferredKey: string, usedKeys: Set<string>): string {
  let key = preferredKey;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${preferredKey}-${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

function createBindingLookup<T>(
  bindings: readonly T[],
  getId: (binding: T) => string | undefined,
  renames: Readonly<Record<string, string>> | undefined,
): (newId: string) => T | undefined {
  const bindingsById = new Map(bindings.map((binding) => [getId(binding), binding]));
  const oldIdsByNewId = new Map(Object.entries(renames ?? {}).map(([oldId, newId]) => [newId, oldId]));
  return (newId) => bindingsById.get(newId) ?? bindingsById.get(oldIdsByNewId.get(newId));
}

function reconcileBoundaryId(
  currentId: string | undefined,
  ports: readonly { id: string }[],
  renames: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!currentId) {
    return undefined;
  }
  const availableIds = new Set(ports.map((port) => port.id));
  if (availableIds.has(currentId)) {
    return currentId;
  }
  const renamedId = renames?.[currentId];
  return renamedId && availableIds.has(renamedId) ? renamedId : undefined;
}

function createBindingListLookup<T>(
  bindings: readonly T[],
  getId: (binding: T) => string | undefined,
  renames: Readonly<Record<string, string>> | undefined,
): (newId: string) => readonly T[] {
  const bindingsById = new Map<string | undefined, T[]>();
  for (const binding of bindings) {
    const id = getId(binding);
    const existing = bindingsById.get(id);
    if (existing) {
      existing.push(binding);
    } else {
      bindingsById.set(id, [binding]);
    }
  }
  const oldIdsByNewId = new Map(Object.entries(renames ?? {}).map(([oldId, newId]) => [newId, oldId]));
  return (newId) => bindingsById.get(newId) ?? bindingsById.get(oldIdsByNewId.get(newId)) ?? [];
}

function hasAmbiguousUiGraphButtonBindings(action: UiGraphRunGraphAction): boolean {
  if (action.inputMappings) {
    const inputIds = new Set<string>();
    for (const binding of action.inputMappings) {
      if (!binding.inputKey.trim() || !binding.stateKey.trim() || inputIds.has(binding.inputKey)) {
        return true;
      }
      inputIds.add(binding.inputKey);
    }
  } else {
    for (const [inputId, binding] of Object.entries(action.inputs ?? {})) {
      if (!inputId.trim() || (binding.type === 'state' && !binding.key.trim())) {
        return true;
      }
    }
  }

  const outputStateKeys = new Set<string>();
  for (const binding of getUiGraphActionOutputBindings(action)) {
    const stateKey = binding.stateKey.trim();
    if (!stateKey || outputStateKeys.has(stateKey)) {
      return true;
    }
    outputStateKeys.add(stateKey);
  }

  return false;
}

function hasCompleteInputCoverage(action: UiGraphRunGraphAction, boundary: GraphBoundary | undefined): boolean {
  if (!boundary) {
    return false;
  }
  const mappedIds = new Set(getUiGraphActionInputBindings(action).map((binding) => binding.inputKey));
  return boundary.inputs.every((input) => mappedIds.has(input.id));
}

function hasCompleteOutputCoverage(action: UiGraphRunGraphAction, boundary: GraphBoundary | undefined): boolean {
  if (!boundary) {
    return false;
  }
  const bindings = getUiGraphActionOutputBindings(action);
  if (bindings.some((binding) => !binding.outputKey)) {
    return true;
  }
  const mappedIds = new Set(bindings.map((binding) => binding.outputKey));
  return boundary.outputs.every((output) => mappedIds.has(output.id));
}

function getGraphBoundaryChange(
  previousProject: Project,
  nextProject: Project,
  graphId: GraphId,
): GraphBoundaryChange | undefined {
  const boundary = getGraphBoundary(nextProject, graphId);
  if (!boundary) {
    return undefined;
  }

  const previousBoundary = getGraphBoundary(previousProject, graphId);
  const inputsChanged =
    !previousBoundary ||
    !areStringArraysEqual(
      previousBoundary.inputs.map((input) => input.id),
      boundary.inputs.map((input) => input.id),
    );
  const outputsChanged =
    !previousBoundary ||
    !areStringArraysEqual(
      previousBoundary.outputs.map((output) => output.id),
      boundary.outputs.map((output) => output.id),
    );
  if (!inputsChanged && !outputsChanged) {
    return undefined;
  }

  return {
    boundary,
    inputsChanged,
    outputsChanged,
    previousBoundary,
    renames: getSafeGraphBoundaryRenames(previousProject.graphs[graphId], nextProject.graphs[graphId]),
  };
}

function getSafeGraphBoundaryRenames(
  previousGraph: NodeGraph | undefined,
  nextGraph: NodeGraph | undefined,
): UiGraphButtonBindingRenames {
  if (!previousGraph || !nextGraph) {
    return {};
  }
  return {
    inputIds: getSafeNodeIdRenames(previousGraph, nextGraph, 'graphInput'),
    outputIds: getSafeNodeIdRenames(previousGraph, nextGraph, 'graphOutput'),
  };
}

function getSafeNodeIdRenames(
  previousGraph: NodeGraph,
  nextGraph: NodeGraph,
  nodeType: 'graphInput' | 'graphOutput',
): Record<string, string> {
  const previousIdCounts = getBoundaryNodeDataIdCounts(previousGraph, nodeType);
  const nextIdCounts = getBoundaryNodeDataIdCounts(nextGraph, nodeType);
  const previousNodes = new Map(
    previousGraph.nodes.filter((node) => node.type === nodeType).map((node) => [node.id, node]),
  );
  const renames: Record<string, string> = {};

  for (const nextNode of nextGraph.nodes) {
    const oldId = getBoundaryNodeDataId(previousNodes.get(nextNode.id));
    const newId = nextNode.type === nodeType ? getBoundaryNodeDataId(nextNode) : undefined;
    if (
      !oldId ||
      !newId ||
      oldId === newId ||
      nextIdCounts.has(oldId) ||
      previousIdCounts.has(newId) ||
      previousIdCounts.get(oldId) !== 1 ||
      nextIdCounts.get(newId) !== 1
    ) {
      continue;
    }
    renames[oldId] = newId;
  }

  return renames;
}

function getBoundaryNodeDataIdCounts(graph: NodeGraph, nodeType: 'graphInput' | 'graphOutput'): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type === nodeType) {
      const id = getBoundaryNodeDataId(node);
      if (id) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function getBoundaryNodeDataId(node: ChartNode | undefined): string | undefined {
  const id = (node?.data as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
