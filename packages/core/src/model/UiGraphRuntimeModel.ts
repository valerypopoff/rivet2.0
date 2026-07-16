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
  type UiGraphDropdownItem,
  type UiGraphGapSize,
  type UiGraphOutputRenderMode,
} from './UiGraph.js';
import { normalizeGraphProgress, type GraphProgress } from './GraphProgress.js';

export type UiGraphOutputRenderModel = {
  hasValue: boolean;
  imageErrorMessage?: string;
  imageSource?: string;
  jsonDownloadValue?: string;
  renderedValue: string;
  renderAs: UiGraphOutputRenderMode;
};

const IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:avif|bmp|gif|jpe?g|png|webp));base64,([\s\S]+)$/i;
const IMAGE_URL_PATTERN = /^(?:https?:\/\/|blob:|\/\/|\/|\.\.?\/)/i;
const RELATIVE_IMAGE_PATH_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:[?#].*)?$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_THRESHOLD = 128 * 1024;
const UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_INITIAL_CHARS = 16 * 1024;
const UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_CHUNK_CHARS = 16 * 1024;

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
      component: Extract<UiGraphComponent, { type: 'dropdown' }>;
      items: readonly UiGraphDropdownItem[];
      label: string;
      type: 'dropdown';
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

export type UiGraphInteractionChange = 'action' | 'graph' | 'presentation' | 'state';

export type UiGraphInteractionSnapshot = Readonly<{
  actionErrors: Readonly<Record<string, string>>;
  actionProgress: Readonly<Record<string, GraphProgress>>;
  collapsedOutputComponentIds: ReadonlySet<UiComponentId>;
  loadingComponentIds: ReadonlySet<UiComponentId>;
  runningComponentIds: ReadonlySet<UiComponentId>;
  state: Readonly<Record<string, unknown>>;
}>;

export type UiGraphActionRunContext = Readonly<{
  abortOtherActions(): void;
  componentId: UiComponentId;
  reportProgress(progress: GraphProgress): void;
  signal: AbortSignal;
  state: Record<string, unknown>;
}>;

export type UiGraphActionRunResult = {
  statePatch?: Record<string, unknown>;
};

export type UiGraphActionRunner = (context: UiGraphActionRunContext) => Promise<UiGraphActionRunResult>;

export type UiGraphInteractionController = {
  abortActions(): void;
  cancelAction(componentId: UiComponentId): void;
  detachActions(): void;
  getSnapshot(): UiGraphInteractionSnapshot;
  reset(): void;
  runAction(component: UiGraphActionComponent, runner: UiGraphActionRunner): Promise<void>;
  setUiGraph(uiGraph: UiGraph): void;
  subscribe(listener: (change: UiGraphInteractionChange) => void): () => void;
  toggleOutputCollapsed(componentId: UiComponentId): void;
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

const ACTION_LOADING_DELAY_MS = 300;

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
  let outputComponentIds = getUiGraphOutputComponentIds(initialUiGraph);
  let outputComponentsByStateKey = getUiGraphOutputComponentsByStateKey(initialUiGraph);
  const initialStateOverride = options.initialState ? { ...options.initialState } : undefined;
  let initialState = normalizeUiGraphDropdownState(
    initialUiGraph,
    initialStateOverride ?? getUiGraphInitialState(initialUiGraph),
  );
  let state = { ...initialState };
  let actionErrors: Record<string, string> = {};
  let actionProgress: Record<string, GraphProgress> = {};
  const collapsedOutputComponentIds = new Set<UiComponentId>();
  let snapshot: UiGraphInteractionSnapshot;
  const actionController = createUiGraphActionExecutionController();
  const activeActions = new Map<number, ActiveUiGraphAction>();
  const loadingActionIds = new Set<number>();
  const loadingDelayTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(change: UiGraphInteractionChange) => void>();

  const updateSnapshot = (): void => {
    snapshot = {
      actionErrors,
      actionProgress,
      collapsedOutputComponentIds: new Set(collapsedOutputComponentIds),
      loadingComponentIds: new Set(
        [...activeActions].flatMap(([executionId, { execution }]) =>
          loadingActionIds.has(executionId) ? [execution.componentId] : [],
        ),
      ),
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
  const clearActionLoadingPresentation = (executionId: number): void => {
    const timer = loadingDelayTimers.get(executionId);
    if (timer != null) {
      clearTimeout(timer);
      loadingDelayTimers.delete(executionId);
    }
    loadingActionIds.delete(executionId);
  };
  const delayActionLoadingPresentation = (execution: UiGraphActionExecution): void => {
    loadingDelayTimers.set(
      execution.id,
      setTimeout(() => {
        loadingDelayTimers.delete(execution.id);
        if (!activeActions.has(execution.id) || !actionController.isCurrent(execution)) return;
        loadingActionIds.add(execution.id);
        publish('action');
      }, ACTION_LOADING_DELAY_MS),
    );
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
      clearActionLoadingPresentation(executionId);
      actionController.finish(activeAction.execution);
      changed = true;
    }
    if (changed && notify) {
      publish('action');
    }
    return changed;
  };
  const abortAllActions = (notify: boolean): void => {
    let changed = abortMatchingActions(() => true, false);
    actionController.reset();
    if (Object.keys(actionProgress).length > 0) {
      actionProgress = {};
      changed = true;
    }
    if (changed && notify) {
      publish('action');
    }
  };
  const removeActionPresentation = (componentId: UiComponentId): void => {
    if (Object.prototype.hasOwnProperty.call(actionErrors, componentId)) {
      actionErrors = { ...actionErrors };
      delete actionErrors[componentId];
    }
    if (Object.prototype.hasOwnProperty.call(actionProgress, componentId)) {
      actionProgress = { ...actionProgress };
      delete actionProgress[componentId];
    }
  };
  const expandOutputsForUpdatedState = (
    stateKeys: Iterable<string>,
    nextState: Readonly<Record<string, unknown>>,
  ): void => {
    for (const stateKey of stateKeys) {
      for (const component of outputComponentsByStateKey.get(stateKey) ?? []) {
        if (getUiGraphOutputRenderModel(nextState, stateKey, component.renderAs ?? 'text').hasValue) {
          collapsedOutputComponentIds.delete(component.id);
        }
      }
    }
  };

  updateSnapshot();

  return {
    abortActions() {
      abortAllActions(true);
    },
    cancelAction(componentId) {
      if (abortMatchingActions(({ execution }) => execution.componentId === componentId, false)) {
        removeActionPresentation(componentId);
        publish('action');
      }
    },
    detachActions() {
      for (const executionId of activeActions.keys()) {
        clearActionLoadingPresentation(executionId);
      }
      activeActions.clear();
      actionController.reset();
      actionProgress = {};
      updateSnapshot();
    },
    getSnapshot() {
      return snapshot;
    },
    reset() {
      abortAllActions(false);
      state = { ...initialState };
      actionErrors = {};
      actionProgress = {};
      collapsedOutputComponentIds.clear();
      publish('state');
    },
    async runAction(component, runner) {
      const execution = actionController.begin(component);
      if (!execution) {
        return;
      }

      const abortController = new AbortController();
      activeActions.set(execution.id, { abortController, execution });
      delayActionLoadingPresentation(execution);
      removeActionPresentation(component.id);
      publish('action');

      try {
        const result = await runner({
          abortOtherActions: () =>
            abortMatchingActions((_activeAction, executionId) => executionId !== execution.id, true),
          componentId: component.id,
          reportProgress: (progress) => {
            if (!actionController.isCurrent(execution)) return;
            const normalized = normalizeGraphProgress(progress);
            if (!normalized) return;
            actionProgress = { ...actionProgress, [component.id]: normalized };
            publish('action');
          },
          signal: abortController.signal,
          state: getUiGraphComponentActionState(component, state),
        });
        if (!actionController.isCurrent(execution)) {
          return;
        }

        const statePatch = actionController.resolveStatePatch(execution, result.statePatch);
        if (statePatch) {
          const nextState = applyUiGraphStatePatch(state, statePatch);
          expandOutputsForUpdatedState(Object.keys(statePatch), nextState);
          state = nextState;
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
          clearActionLoadingPresentation(execution.id);
          actionController.finish(execution);
          if (Object.prototype.hasOwnProperty.call(actionProgress, component.id)) {
            actionProgress = { ...actionProgress };
            delete actionProgress[component.id];
          }
          publish('action');
        }
      }
    },
    setUiGraph(nextUiGraph) {
      if (nextUiGraph.id !== uiGraphId) {
        abortAllActions(false);
        uiGraphId = nextUiGraph.id;
        initialState = initialStateOverride ?? getUiGraphInitialState(nextUiGraph);
        state = { ...initialState };
        actionErrors = {};
        actionProgress = {};
        outputComponentIds = getUiGraphOutputComponentIds(nextUiGraph);
        outputComponentsByStateKey = getUiGraphOutputComponentsByStateKey(nextUiGraph);
        collapsedOutputComponentIds.clear();
        publish('graph');
        return;
      }

      if (!initialStateOverride) {
        initialState = getUiGraphInitialState(nextUiGraph);
      }

      const normalizedState = normalizeUiGraphDropdownState(nextUiGraph, state);
      const stateChanged = normalizedState !== state;
      if (stateChanged) {
        state = normalizedState;
      }

      outputComponentIds = getUiGraphOutputComponentIds(nextUiGraph);
      outputComponentsByStateKey = getUiGraphOutputComponentsByStateKey(nextUiGraph);
      const collapsedOutputIdsBeforeCleanup = collapsedOutputComponentIds.size;
      for (const componentId of collapsedOutputComponentIds) {
        if (!outputComponentIds.has(componentId)) {
          collapsedOutputComponentIds.delete(componentId);
        }
      }

      const actionComponentIds = new Set(
        nextUiGraph.components
          .filter((component) => component.type === 'button' || component.type === 'chat')
          .map((component) => component.id),
      );
      let changed =
        collapsedOutputComponentIds.size !== collapsedOutputIdsBeforeCleanup ||
        stateChanged ||
        abortMatchingActions(({ execution }) => !actionComponentIds.has(execution.componentId), false);
      const remainingErrors = Object.fromEntries(
        Object.entries(actionErrors).filter(([componentId]) => actionComponentIds.has(componentId as UiComponentId)),
      );
      const remainingProgress = Object.fromEntries(
        Object.entries(actionProgress).filter(([componentId]) => actionComponentIds.has(componentId as UiComponentId)),
      );
      if (Object.keys(remainingErrors).length !== Object.keys(actionErrors).length) {
        actionErrors = remainingErrors;
        changed = true;
      }
      if (Object.keys(remainingProgress).length !== Object.keys(actionProgress).length) {
        actionProgress = remainingProgress;
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
    toggleOutputCollapsed(componentId) {
      if (!outputComponentIds.has(componentId)) {
        return;
      }

      if (collapsedOutputComponentIds.has(componentId)) {
        collapsedOutputComponentIds.delete(componentId);
      } else {
        collapsedOutputComponentIds.add(componentId);
      }
      publish('presentation');
    },
    updateState(stateKey, value) {
      actionController.noteStateWrite(stateKey);
      const nextState = { ...state, [stateKey]: value };
      expandOutputsForUpdatedState([stateKey], nextState);
      state = nextState;
      publish('state');
    },
    updateStatePatch(statePatch) {
      for (const stateKey of Object.keys(statePatch)) {
        actionController.noteStateWrite(stateKey);
      }
      const nextState = applyUiGraphStatePatch(state, statePatch);
      expandOutputsForUpdatedState(Object.keys(statePatch), nextState);
      state = nextState;
      publish('state');
    },
  };
}

function getUiGraphOutputComponentIds(uiGraph: UiGraph): Set<UiComponentId> {
  return new Set(
    uiGraph.components.filter((component) => component.type === 'output').map((component) => component.id),
  );
}

function getUiGraphOutputComponentsByStateKey(
  uiGraph: UiGraph,
): Map<string, Extract<UiGraphComponent, { type: 'output' }>[]> {
  const componentsByStateKey = new Map<string, Extract<UiGraphComponent, { type: 'output' }>[]>();
  for (const component of uiGraph.components) {
    if (component.type !== 'output') continue;
    const components = componentsByStateKey.get(component.stateKey) ?? [];
    components.push(component);
    componentsByStateKey.set(component.stateKey, components);
  }
  return componentsByStateKey;
}

function normalizeUiGraphDropdownState(
  uiGraph: UiGraph,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  let normalizedState: Record<string, unknown> | undefined;

  for (const component of uiGraph.components) {
    if (component.type !== 'dropdown') {
      continue;
    }

    const selectedValue = `${state[component.stateKey] ?? ''}`;
    if (selectedValue === '' || component.items.some((item) => item.value === selectedValue)) {
      continue;
    }

    normalizedState ??= { ...state };
    normalizedState[component.stateKey] = '';
  }

  return normalizedState ?? (state as Record<string, unknown>);
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
    case 'dropdown': {
      const selectedValue = `${state[component.stateKey] ?? ''}`;
      return {
        component,
        items: component.items,
        label: getUiGraphComponentLabel(component),
        type: 'dropdown',
        value: component.items.some((item) => item.value === selectedValue) ? selectedValue : '',
      };
    }
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
  component: Extract<UiGraphComponent, { type: 'input' | 'textarea' | 'dropdown' | 'output' }>,
): string {
  return component.label || component.stateKey;
}

export function getUiGraphOutputRenderModel(
  state: Readonly<Record<string, unknown>>,
  stateKey: string,
  renderAs: UiGraphOutputRenderMode,
): UiGraphOutputRenderModel {
  const value = state[stateKey];
  const renderedValue = renderUiGraphOutputValue(value, renderAs);
  const hasStateValue = hasUiGraphStateValue(state, stateKey);
  const hasImageValue = hasStateValue && value != null && value !== '';
  const imageSource = hasImageValue && renderAs === 'image' ? getUiGraphImageSource(value) : undefined;
  const imageErrorMessage =
    hasImageValue && renderAs === 'image' && !imageSource ? 'Expected an image URL or base64 image.' : undefined;
  const hasValue =
    renderAs === 'image' ? imageSource != null || imageErrorMessage != null : renderedValue.trim().length > 0;

  return {
    hasValue,
    ...(imageErrorMessage ? { imageErrorMessage } : {}),
    ...(imageSource ? { imageSource } : {}),
    ...(hasValue && renderAs === 'json' ? { jsonDownloadValue: renderedValue } : {}),
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

/**
 * Splits very large JSON output into append-only DOM text chunks. Appending the
 * chunks lets browser renderers show the first screenful without blocking on
 * layout for every visual line in one huge escaped JSON string.
 */
export function getUiGraphProgressiveJsonOutputChunks(value: string): readonly string[] | undefined {
  if (value.length < UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_THRESHOLD) {
    return undefined;
  }

  const chunks: string[] = [];
  let offset = 0;
  let chunkLength = UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_INITIAL_CHARS;
  while (offset < value.length) {
    let nextOffset = Math.min(value.length, offset + chunkLength);
    if (
      nextOffset < value.length &&
      isHighSurrogate(value.charCodeAt(nextOffset - 1)) &&
      isLowSurrogate(value.charCodeAt(nextOffset))
    ) {
      nextOffset += 1;
    }
    chunks.push(value.slice(offset, nextOffset));
    offset = nextOffset;
    chunkLength = UI_GRAPH_PROGRESSIVE_JSON_OUTPUT_CHUNK_CHARS;
  }

  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export function getUiGraphImageSource(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const source = value.trim();
  if (!source) {
    return undefined;
  }

  const dataUrl = IMAGE_DATA_URL_PATTERN.exec(source);
  if (dataUrl) {
    const base64 = normalizeBase64(dataUrl[2]!);
    return base64 ? `data:${normalizeImageMediaType(dataUrl[1]!)};base64,${base64}` : undefined;
  }

  const base64 = normalizeBase64(source);
  const inferredMediaType = base64 ? inferBase64ImageMediaType(base64) : undefined;
  if (base64 && inferredMediaType) {
    return `data:${inferredMediaType};base64,${base64}`;
  }

  if (!IMAGE_URL_PATTERN.test(source) && !RELATIVE_IMAGE_PATH_PATTERN.test(source)) {
    return undefined;
  }

  try {
    const protocol = new URL(source, 'https://rivet.invalid').protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'blob:' ? source : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBase64(value: string): string | undefined {
  const compact = value.replace(/\s/g, '');
  return compact.length >= 8 && compact.length % 4 !== 1 && BASE64_PATTERN.test(compact) ? compact : undefined;
}

function normalizeImageMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function inferBase64ImageMediaType(value: string): string | undefined {
  if (value.startsWith('iVBORw0KGgo')) return 'image/png';
  if (value.startsWith('/9j/')) return 'image/jpeg';
  if (value.startsWith('R0lGODdh') || value.startsWith('R0lGODlh')) return 'image/gif';
  return undefined;
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
