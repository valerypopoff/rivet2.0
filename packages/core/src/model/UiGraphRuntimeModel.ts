import {
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessages,
  getUiGraphComponentActionOutputStateKeys,
  getUiGraphComponentActionState,
  getUiGraphInitialState,
  type UiComponentId,
  type UiGraph,
  type UiGraphActionComponent,
  type UiGraphChatMessage,
  type UiGraphComponent,
  type UiGraphGapSize,
  type UiGraphOutputRenderMode,
} from './UiGraph.js';

export type UiGraphOutputRenderModel = {
  hasValue: boolean;
  jsonDownloadValue?: string;
  renderedValue: string;
  renderAs: UiGraphOutputRenderMode;
};

export type UiGraphComponentRenderModel =
  | {
      component: Extract<UiGraphComponent, { type: 'text' }>;
      text: string;
      type: 'text';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'markdown' }>;
      markdown: string;
      type: 'markdown';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'gap' }>;
      size: UiGraphGapSize;
      type: 'gap';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'input' | 'textarea' }>;
      label: string;
      type: 'input' | 'textarea';
      value: string;
    }
  | {
      component: Extract<UiGraphComponent, { type: 'button' }>;
      label: string;
      type: 'button';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'chat' }>;
      draft: string;
      messages: UiGraphChatMessage[];
      type: 'chat';
    }
  | {
      component: Extract<UiGraphComponent, { type: 'output' }>;
      label: string;
      output: UiGraphOutputRenderModel;
      type: 'output';
    };

export type UiGraphActionExecution = Readonly<{
  componentId: UiComponentId;
  id: number;
}>;

export type UiGraphActionExecutionController = {
  begin(component: UiGraphActionComponent): UiGraphActionExecution | undefined;
  finish(execution: UiGraphActionExecution): boolean;
  isCurrent(execution: UiGraphActionExecution): boolean;
  isRunning(componentId: UiComponentId): boolean;
  noteStateWrite(stateKey: string): void;
  resolveStatePatch(
    execution: UiGraphActionExecution,
    statePatch: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined;
  reset(): void;
};

export type UiGraphInteractionChange = 'action' | 'graph' | 'state';

export type UiGraphInteractionSnapshot = Readonly<{
  actionErrors: Readonly<Record<string, string>>;
  runningComponentIds: ReadonlySet<UiComponentId>;
  state: Readonly<Record<string, unknown>>;
}>;

export type UiGraphActionRunContext = Readonly<{
  abortOtherActions(): void;
  componentId: UiComponentId;
  signal: AbortSignal;
  state: Record<string, unknown>;
}>;

export type UiGraphActionRunResult = {
  statePatch?: Record<string, unknown>;
};

export type UiGraphActionRunner = (context: UiGraphActionRunContext) => Promise<UiGraphActionRunResult>;

export type UiGraphInteractionController = {
  abortActions(): void;
  getSnapshot(): UiGraphInteractionSnapshot;
  runAction(component: UiGraphActionComponent, runner: UiGraphActionRunner): Promise<void>;
  setUiGraph(uiGraph: UiGraph): void;
  subscribe(listener: (change: UiGraphInteractionChange) => void): () => void;
  updateState(stateKey: string, value: unknown): void;
  updateStatePatch(statePatch: Record<string, unknown>): void;
};

export type UiGraphInteractionControllerOptions = {
  initialState?: Record<string, unknown>;
};

type ActiveUiGraphAction = Readonly<{
  abortController: AbortController;
  execution: UiGraphActionExecution;
}>;

/**
 * Coordinates independent web-app actions without allowing older completions to
 * clear newer loading states or overwrite newer writes to the same UI state key.
 */
export function createUiGraphActionExecutionController(): UiGraphActionExecutionController {
  let nextVersion = 0;
  const activeExecutionByComponent = new Map<UiComponentId, number>();
  const latestWriterByStateKey = new Map<string, number>();

  return {
    begin(component) {
      if (activeExecutionByComponent.has(component.id)) {
        return undefined;
      }

      const execution = { componentId: component.id, id: ++nextVersion };
      activeExecutionByComponent.set(component.id, execution.id);

      for (const stateKey of getUiGraphComponentActionOutputStateKeys(component)) {
        latestWriterByStateKey.set(stateKey, execution.id);
      }

      return execution;
    },
    finish(execution) {
      if (activeExecutionByComponent.get(execution.componentId) !== execution.id) {
        return false;
      }

      activeExecutionByComponent.delete(execution.componentId);
      return true;
    },
    isCurrent(execution) {
      return activeExecutionByComponent.get(execution.componentId) === execution.id;
    },
    isRunning(componentId) {
      return activeExecutionByComponent.has(componentId);
    },
    noteStateWrite(stateKey) {
      const normalizedStateKey = stateKey.trim();
      if (normalizedStateKey) {
        latestWriterByStateKey.set(normalizedStateKey, ++nextVersion);
      }
    },
    resolveStatePatch(execution, statePatch) {
      if (!statePatch) {
        return undefined;
      }

      const applicableEntries = Object.entries(statePatch).filter(
        ([stateKey]) => latestWriterByStateKey.get(stateKey) === execution.id,
      );
      return applicableEntries.length > 0 ? Object.fromEntries(applicableEntries) : undefined;
    },
    reset() {
      activeExecutionByComponent.clear();
      latestWriterByStateKey.clear();
    },
  };
}

/**
 * Owns mutable web-app interaction state for every renderer. React and direct
 * DOM hosts subscribe to this controller instead of reimplementing action
 * cancellation, loading/error state, and stale state-patch protection.
 */
export function createUiGraphInteractionController(
  initialUiGraph: UiGraph,
  options: UiGraphInteractionControllerOptions = {},
): UiGraphInteractionController {
  let uiGraphId = initialUiGraph.id;
  let state = options.initialState ? { ...options.initialState } : getUiGraphInitialState(initialUiGraph);
  let actionErrors: Record<string, string> = {};
  let snapshot: UiGraphInteractionSnapshot;
  const actionController = createUiGraphActionExecutionController();
  const activeActions = new Map<number, ActiveUiGraphAction>();
  const listeners = new Set<(change: UiGraphInteractionChange) => void>();

  const updateSnapshot = (): void => {
    snapshot = {
      actionErrors,
      runningComponentIds: new Set([...activeActions.values()].map(({ execution }) => execution.componentId)),
      state,
    };
  };
  const publish = (change: UiGraphInteractionChange): void => {
    updateSnapshot();
    for (const listener of listeners) {
      listener(change);
    }
  };
  const abortMatchingActions = (
    predicate: (activeAction: ActiveUiGraphAction, executionId: number) => boolean,
    notify: boolean,
  ): boolean => {
    let changed = false;
    for (const [executionId, activeAction] of activeActions) {
      if (!predicate(activeAction, executionId)) {
        continue;
      }
      activeAction.abortController.abort();
      activeActions.delete(executionId);
      actionController.finish(activeAction.execution);
      changed = true;
    }
    if (changed && notify) {
      publish('action');
    }
    return changed;
  };
  const abortAllActions = (notify: boolean): void => {
    const changed = abortMatchingActions(() => true, false);
    actionController.reset();
    if (changed && notify) {
      publish('action');
    }
  };

  updateSnapshot();

  return {
    abortActions() {
      abortAllActions(true);
    },
    getSnapshot() {
      return snapshot;
    },
    async runAction(component, runner) {
      const execution = actionController.begin(component);
      if (!execution) {
        return;
      }

      const abortController = new AbortController();
      activeActions.set(execution.id, { abortController, execution });
      if (Object.prototype.hasOwnProperty.call(actionErrors, component.id)) {
        actionErrors = { ...actionErrors };
        delete actionErrors[component.id];
      }
      publish('action');

      try {
        const result = await runner({
          abortOtherActions: () =>
            abortMatchingActions((_activeAction, executionId) => executionId !== execution.id, true),
          componentId: component.id,
          signal: abortController.signal,
          state: getUiGraphComponentActionState(component, state),
        });
        if (!actionController.isCurrent(execution)) {
          return;
        }

        const statePatch = actionController.resolveStatePatch(execution, result.statePatch);
        if (statePatch) {
          state = applyUiGraphStatePatch(state, statePatch);
        }
      } catch (error) {
        if (!abortController.signal.aborted && actionController.isCurrent(execution)) {
          actionErrors = {
            ...actionErrors,
            [component.id]: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        if (activeActions.delete(execution.id)) {
          actionController.finish(execution);
          publish('action');
        }
      }
    },
    setUiGraph(nextUiGraph) {
      if (nextUiGraph.id !== uiGraphId) {
        abortAllActions(false);
        uiGraphId = nextUiGraph.id;
        state = getUiGraphInitialState(nextUiGraph);
        actionErrors = {};
        publish('graph');
        return;
      }

      const actionComponentIds = new Set(
        nextUiGraph.components
          .filter((component) => component.type === 'button' || component.type === 'chat')
          .map((component) => component.id),
      );
      let changed = abortMatchingActions(({ execution }) => !actionComponentIds.has(execution.componentId), false);
      const remainingErrors = Object.fromEntries(
        Object.entries(actionErrors).filter(([componentId]) => actionComponentIds.has(componentId as UiComponentId)),
      );
      if (Object.keys(remainingErrors).length !== Object.keys(actionErrors).length) {
        actionErrors = remainingErrors;
        changed = true;
      }
      if (changed) {
        publish('graph');
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateState(stateKey, value) {
      actionController.noteStateWrite(stateKey);
      state = { ...state, [stateKey]: value };
      publish('state');
    },
    updateStatePatch(statePatch) {
      for (const stateKey of Object.keys(statePatch)) {
        actionController.noteStateWrite(stateKey);
      }
      state = applyUiGraphStatePatch(state, statePatch);
      publish('state');
    },
  };
}

export function getUiGraphComponentRenderModel(
  component: UiGraphComponent,
  state: Readonly<Record<string, unknown>>,
): UiGraphComponentRenderModel {
  switch (component.type) {
    case 'text':
      return { component, text: component.text, type: 'text' };
    case 'markdown':
      return { component, markdown: component.markdown, type: 'markdown' };
    case 'gap':
      return { component, size: component.size, type: 'gap' };
    case 'input':
    case 'textarea':
      return {
        component,
        label: getUiGraphComponentLabel(component),
        type: component.type,
        value: `${state[component.stateKey] ?? component.defaultValue ?? ''}`,
      };
    case 'button':
      return { component, label: component.label, type: 'button' };
    case 'chat':
      return {
        component,
        draft: `${state[getUiGraphChatDraftStateKey(component.id)] ?? ''}`,
        messages: getUiGraphChatMessages(component.id, state),
        type: 'chat',
      };
    case 'output':
      return {
        component,
        label: getUiGraphComponentLabel(component),
        output: getUiGraphOutputRenderModel(state, component.stateKey, component.renderAs ?? 'text'),
        type: 'output',
      };
  }
}

export function getUiGraphComponentLabel(
  component: Extract<UiGraphComponent, { type: 'input' | 'textarea' | 'output' }>,
): string {
  return component.label || component.stateKey;
}

export function getUiGraphOutputRenderModel(
  state: Readonly<Record<string, unknown>>,
  stateKey: string,
  renderAs: UiGraphOutputRenderMode,
): UiGraphOutputRenderModel {
  const value = state[stateKey];
  const hasValue = hasUiGraphStateValue(state, stateKey);
  const renderedValue = renderUiGraphOutputValue(value, renderAs);

  return {
    hasValue,
    ...(hasValue && renderAs === 'json' ? { jsonDownloadValue: stringifyUiGraphValue(value) } : {}),
    renderedValue,
    renderAs,
  };
}

export function hasUiGraphStateValue(state: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(state, key) && state[key] !== undefined;
}

export function renderUiGraphOutputValue(value: unknown, renderAs: UiGraphOutputRenderMode): string {
  if (renderAs === 'json') {
    return stringifyUiGraphValue(value) ?? '';
  }

  return typeof value === 'string' ? value : value == null ? '' : stringifyUiGraphValue(value) ?? '';
}

export function stringifyUiGraphValue(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[Unserializable value]';
  }
}

export function getUiGraphJsonOutputFilename(appName: string, date = new Date()): string {
  const safeName = appName
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80);

  return `${safeName || 'Rivet web app'} ${formatUiGraphDownloadDateTime(date)}.json`;
}

export function formatUiGraphDownloadDateTime(date: Date): string {
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(
    date.getMinutes(),
  )}-${pad(date.getSeconds())}`;
}

export function applyUiGraphStatePatch(
  state: Record<string, unknown>,
  statePatch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return statePatch ? { ...state, ...statePatch } : state;
}
