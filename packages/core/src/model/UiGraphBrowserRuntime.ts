import {
  getUiGraphChatDraftStateKey,
  getUiGraphChatMessages,
  getUiGraphChatMessagesStateKey,
  getUiGraphChatPins,
  getUiGraphChatPinsStateKey,
  type UiGraph,
  type UiGraphChatMessage,
} from './UiGraph.js';
import { getUiGraphJsonOutputFilename } from './UiGraphRuntimeModel.js';
import { isAgentResponseTrace, type AgentResponseTrace } from './AgentResponseTrace.js';

type UiGraphBrowserStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;
type UiGraphStorageLocation = Pick<Location, 'origin' | 'pathname'>;

const OUTPUT_MAX_HEIGHT_PX = 800;
const OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO = 0.8;
const OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-min-height';
const OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY = '--rivet-web-app-output-resize-max-height';
const CHAT_SEARCH_MATCH_CLASS = 'rivet-web-app-chat-search-match';
const CHAT_SEARCH_ACTIVE_MATCH_CLASS = 'rivet-web-app-chat-search-match-active';
const UI_GRAPH_CHAT_STORAGE_PREFIX = 'rivet-web-app-chat-state:v1';
const UI_GRAPH_APP_STORAGE_PREFIX = 'rivet-web-app-storage:v1';
const UI_GRAPH_RESPONSE_TRACE_STORAGE_PREFIX = 'rivet-web-app-response-traces:v1';
const UI_GRAPH_RESPONSE_TRACE_LIMIT = 100;
const responseTraceMemoryFallback = new Map<string, AgentResponseTrace[]>();
const unsyncedResponseTraceKeysByStorage = new WeakMap<UiGraphBrowserStorage, Set<string>>();

export type UiGraphChatMessageTimestampPresentation = Readonly<{
  dateTime: string;
  /** Present only for an assistant response with a valid preceding user-turn timestamp. */
  elapsedSincePreviousUserMessage?: string;
  label: string;
}>;

export type UiGraphChatMessagePresentation = Readonly<{
  dateSeparator?: UiGraphChatMessageTimestampPresentation;
  timestamp?: UiGraphChatMessageTimestampPresentation;
}>;

export type UiGraphChatMessagePresentationOptions = Readonly<{
  locales?: Intl.LocalesArgument;
  timeZone?: string;
}>;

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getPixelValue = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const setStyleProperty = (element: HTMLElement, property: string, value: string): void => {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getDefaultUiGraphBrowserStorage = (): UiGraphBrowserStorage | undefined => {
  try {
    return globalThis.localStorage ?? globalThis.window?.localStorage;
  } catch {
    // Embedded, private, and restricted browser contexts can reject storage.
    return undefined;
  }
};

const getDefaultUiGraphStorageLocation = (): UiGraphStorageLocation | undefined => {
  try {
    return globalThis.location ?? globalThis.window?.location;
  } catch {
    return undefined;
  }
};

/**
 * Formats persisted Chat timestamps in the current browser locale and timezone.
 * Undated or malformed legacy messages deliberately remain present without time
 * metadata rather than being assigned a fabricated date.
 */
export function getUiGraphChatMessagePresentations(
  messages: readonly UiGraphChatMessage[],
  options: UiGraphChatMessagePresentationOptions = {},
): UiGraphChatMessagePresentation[] {
  const { locales, timeZone } = options;
  const timeFormatter = new Intl.DateTimeFormat(locales, {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  const dateFormatter = new Intl.DateTimeFormat(locales, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
  const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
  const entries = messages.map((message) => {
    const timestamp = parseUiGraphChatTimestamp(message.timestamp);
    if (!timestamp) return undefined;

    return {
      dateKey: dateKeyFormatter.format(timestamp),
      dateTime: timestamp.toISOString(),
      dateLabel: dateFormatter.format(timestamp),
      timeLabel: timeFormatter.format(timestamp),
      timestamp,
    };
  });
  const hasMultipleDates = new Set(entries.flatMap((entry) => (entry ? [entry.dateKey] : []))).size > 1;
  let previousDateKey: string | undefined;
  let previousUserTimestamp: Date | undefined;

  return entries.map((entry, index) => {
    const message = messages[index]!;
    if (message.role === 'user') {
      previousUserTimestamp = entry?.timestamp;
    }
    if (!entry) return {};

    const dateSeparator =
      hasMultipleDates && previousDateKey != null && previousDateKey !== entry.dateKey
        ? { dateTime: entry.dateTime, label: entry.dateLabel }
        : undefined;
    previousDateKey = entry.dateKey;

    const elapsedSincePreviousUserMessage =
      message.role === 'assistant' && previousUserTimestamp
        ? formatUiGraphChatElapsedSeconds(entry.timestamp.getTime() - previousUserTimestamp.getTime())
        : undefined;

    return {
      ...(dateSeparator ? { dateSeparator } : {}),
      timestamp: {
        dateTime: entry.dateTime,
        ...(elapsedSincePreviousUserMessage ? { elapsedSincePreviousUserMessage } : {}),
        label: entry.timeLabel,
      },
    };
  });
}

/** Formats a browser-observed assistant-response delay without altering stored timestamps. */
const formatUiGraphChatElapsedSeconds = (elapsedMilliseconds: number): string | undefined => {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) return undefined;

  const seconds = Math.round((elapsedMilliseconds / 1_000) * 10) / 10;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} seconds after previous user message`;
};

const parseUiGraphChatTimestamp = (value: unknown): Date | undefined => {
  if (typeof value !== 'string') return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp;
};

/** Returns the browser-local key for one app URL and one persisted UI graph. */
export function getUiGraphChatStorageKey(
  uiGraph: UiGraph,
  location: UiGraphStorageLocation | undefined = getDefaultUiGraphStorageLocation(),
): string | undefined {
  if (!location?.origin) {
    return undefined;
  }

  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  return [
    UI_GRAPH_CHAT_STORAGE_PREFIX,
    encodeURIComponent(location.origin),
    encodeURIComponent(pathname),
    encodeURIComponent(uiGraph.id),
  ].join(':');
}

/** Returns the browser-local key for graph-managed storage owned by one web app. */
export function getUiGraphWebAppStorageKey(
  uiGraph: UiGraph,
  location: UiGraphStorageLocation | undefined = getDefaultUiGraphStorageLocation(),
): string | undefined {
  if (!location?.origin) {
    return undefined;
  }

  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  return [
    UI_GRAPH_APP_STORAGE_PREFIX,
    encodeURIComponent(location.origin),
    encodeURIComponent(pathname),
    encodeURIComponent(uiGraph.id),
  ].join(':');
}

function getUiGraphResponseTraceStorageKey(
  uiGraph: UiGraph,
  componentId: string,
  location: UiGraphStorageLocation | undefined = getDefaultUiGraphStorageLocation(),
): string | undefined {
  if (!location?.origin) return undefined;
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  return [
    UI_GRAPH_RESPONSE_TRACE_STORAGE_PREFIX,
    encodeURIComponent(location.origin),
    encodeURIComponent(pathname),
    encodeURIComponent(uiGraph.id),
    encodeURIComponent(componentId),
  ].join(':');
}

const isUiGraphResponseInspectionEnabled = (uiGraph: UiGraph, componentId: string): boolean =>
  uiGraph.components.some(
    (component) =>
      component.type === 'chat' && component.id === componentId && component.allowResponseInspection === true,
  );

const removeUiGraphChatResponseTraceIds = (messages: readonly UiGraphChatMessage[]): UiGraphChatMessage[] =>
  messages.map((message) => {
    if (message.responseTraceId == null) return message;
    const sanitized = { ...message };
    delete sanitized.responseTraceId;
    return sanitized;
  });

const purgeDisabledUiGraphResponseTraces = (
  uiGraph: UiGraph,
  storage: UiGraphBrowserStorage | undefined,
  location?: UiGraphStorageLocation,
): void => {
  for (const component of uiGraph.components) {
    if (component.type !== 'chat' || component.allowResponseInspection === true) continue;
    const key =
      getUiGraphResponseTraceStorageKey(uiGraph, component.id, location) ?? `memory:${uiGraph.id}:${component.id}`;
    persistUiGraphResponseTraces(key, [], storage);
  }
};

/** Persists a validated trace outside Chat history so it never enters model context. */
export function saveUiGraphResponseTrace(
  uiGraph: UiGraph,
  componentId: string,
  trace: AgentResponseTrace,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): void {
  if (!isAgentResponseTrace(trace)) return;
  if (!isUiGraphResponseInspectionEnabled(uiGraph, componentId)) {
    const key =
      getUiGraphResponseTraceStorageKey(uiGraph, componentId, location) ?? `memory:${uiGraph.id}:${componentId}`;
    persistUiGraphResponseTraces(key, [], storage);
    return;
  }
  const key =
    getUiGraphResponseTraceStorageKey(uiGraph, componentId, location) ?? `memory:${uiGraph.id}:${componentId}`;
  const traces = loadUiGraphResponseTraces(uiGraph, componentId, storage, location).filter(
    (candidate) => candidate.traceId !== trace.traceId,
  );
  traces.push(trace);
  const bounded = traces.slice(-UI_GRAPH_RESPONSE_TRACE_LIMIT);
  persistUiGraphResponseTraces(key, bounded, storage);
}

/** Loads one validated response trace from the app/UI-graph-scoped store. */
export function loadUiGraphResponseTrace(
  uiGraph: UiGraph,
  componentId: string,
  traceId: string,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): AgentResponseTrace | undefined {
  if (!isUiGraphResponseInspectionEnabled(uiGraph, componentId)) return undefined;
  return loadUiGraphResponseTraces(uiGraph, componentId, storage, location).find((trace) => trace.traceId === traceId);
}

/** Removes retained traces no longer referenced by Chat messages. */
export function pruneUiGraphResponseTraces(
  uiGraph: UiGraph,
  state: Readonly<Record<string, unknown>>,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): void {
  for (const component of uiGraph.components) {
    if (component.type !== 'chat') continue;
    const referenced =
      component.allowResponseInspection === true
        ? new Set(
            getUiGraphChatMessages(component.id, state).flatMap((message) =>
              typeof message.responseTraceId === 'string' ? [message.responseTraceId] : [],
            ),
          )
        : new Set<string>();
    const key =
      getUiGraphResponseTraceStorageKey(uiGraph, component.id, location) ?? `memory:${uiGraph.id}:${component.id}`;
    const retained = loadUiGraphResponseTraces(uiGraph, component.id, storage, location).filter((trace) =>
      referenced.has(trace.traceId),
    );
    persistUiGraphResponseTraces(key, retained, storage);
  }
}

function persistUiGraphResponseTraces(
  key: string,
  traces: AgentResponseTrace[],
  storage: UiGraphBrowserStorage | undefined,
): void {
  responseTraceMemoryFallback.set(key, traces);
  if (!storage || key.startsWith('memory:')) return;

  try {
    if (traces.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(traces));
    unsyncedResponseTraceKeysByStorage.get(storage)?.delete(key);
  } catch {
    const unsyncedKeys = unsyncedResponseTraceKeysByStorage.get(storage) ?? new Set<string>();
    unsyncedKeys.add(key);
    unsyncedResponseTraceKeysByStorage.set(storage, unsyncedKeys);
  }
}

function loadUiGraphResponseTraces(
  uiGraph: UiGraph,
  componentId: string,
  storage: UiGraphBrowserStorage | undefined,
  location?: UiGraphStorageLocation,
): AgentResponseTrace[] {
  const key =
    getUiGraphResponseTraceStorageKey(uiGraph, componentId, location) ?? `memory:${uiGraph.id}:${componentId}`;
  if (storage && unsyncedResponseTraceKeysByStorage.get(storage)?.has(key)) {
    return responseTraceMemoryFallback.get(key) ?? [];
  }
  if (storage && !key.startsWith('memory:')) {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const traces = parsed.filter(isAgentResponseTrace).slice(-UI_GRAPH_RESPONSE_TRACE_LIMIT);
          responseTraceMemoryFallback.set(key, traces);
          return traces;
        }
      }
    } catch {
      // Fall through to the in-memory copy.
    }
  }
  return responseTraceMemoryFallback.get(key) ?? [];
}

/** Loads the browser snapshot used by Stored Value nodes for this one web app. */
export function loadUiGraphWebAppStorage(
  uiGraph: UiGraph,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): Record<string, unknown> {
  const key = getUiGraphWebAppStorageKey(uiGraph, location);
  if (!key || !storage) return {};

  try {
    const serialized = storage.getItem(key);
    if (!serialized) return {};
    const value: unknown = JSON.parse(serialized);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** Merges a successful action's changed keys and persists the complete app-local record. */
export function applyUiGraphWebAppStoragePatch(
  uiGraph: UiGraph,
  currentStorage: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): Record<string, unknown> {
  const key = getUiGraphWebAppStorageKey(uiGraph, location);
  if (!key || !storage) {
    throw new Error('Browser storage is unavailable for this web app.');
  }

  const nextStorage = { ...currentStorage, ...patch };
  let serialized: string;
  try {
    serialized = JSON.stringify(nextStorage);
    storage.setItem(key, serialized);
  } catch (error) {
    throw new Error('Web app storage could not be saved. Browser storage may be unavailable or full.', {
      cause: error,
    });
  }
  return nextStorage;
}

/**
 * Applies the keys from one completed action that have not already been superseded.
 * Ordering metadata is committed only after persistence succeeds, so a failed newer
 * write cannot suppress an older successful action that completes later.
 */
export function applyUiGraphWebAppStorageActionPatch(
  patch: Readonly<Record<string, unknown>>,
  actionNumber: number,
  appliedActionByKey: Map<string, number>,
  persist: (applicablePatch: Record<string, unknown>) => void,
): Record<string, unknown> {
  const applicablePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => actionNumber >= (appliedActionByKey.get(key) ?? 0)),
  );
  const applicableKeys = Object.keys(applicablePatch);
  if (applicableKeys.length === 0) return applicablePatch;

  persist(applicablePatch);
  for (const key of applicableKeys) appliedActionByKey.set(key, actionNumber);
  return applicablePatch;
}

/** Selects and validates the private browser-persisted state of Chat components only. */
export function getUiGraphChatPersistentState(
  uiGraph: UiGraph,
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const persistentState: Record<string, unknown> = {};

  for (const component of uiGraph.components) {
    if (component.type !== 'chat') continue;

    const draftStateKey = getUiGraphChatDraftStateKey(component.id);
    const messagesStateKey = getUiGraphChatMessagesStateKey(component.id);
    const pinsStateKey = getUiGraphChatPinsStateKey(component.id);
    const draft = state[draftStateKey];
    const messages = getUiGraphChatMessages(component.id, state);
    const persistedMessages =
      component.allowResponseInspection === true ? messages : removeUiGraphChatResponseTraceIds(messages);
    const pins = getUiGraphChatPins(component.id, state).map((pin) => pin.messageIndex);

    if (typeof draft === 'string' && draft) {
      persistentState[draftStateKey] = draft;
    }
    if (persistedMessages.length > 0) {
      persistentState[messagesStateKey] = persistedMessages;
    }
    if (pins.length > 0) {
      persistentState[pinsStateKey] = pins;
    }
  }

  return persistentState;
}

/**
 * Reports whether a state transition changed the browser-persisted portion of
 * any Chat. Runtime state updates are immutable, so reference comparison keeps
 * action progress and unrelated form edits from serializing a large history.
 */
export function hasUiGraphChatPersistentStateChanged(
  uiGraph: UiGraph,
  previousState: Readonly<Record<string, unknown>>,
  nextState: Readonly<Record<string, unknown>>,
): boolean {
  return uiGraph.components.some((component) => {
    if (component.type !== 'chat') return false;

    return (
      previousState[getUiGraphChatDraftStateKey(component.id)] !==
        nextState[getUiGraphChatDraftStateKey(component.id)] ||
      previousState[getUiGraphChatMessagesStateKey(component.id)] !==
        nextState[getUiGraphChatMessagesStateKey(component.id)] ||
      previousState[getUiGraphChatPinsStateKey(component.id)] !== nextState[getUiGraphChatPinsStateKey(component.id)]
    );
  });
}

/** Loads valid Chat-only state without allowing malformed local storage to affect rendering. */
export function loadUiGraphChatPersistentState(
  uiGraph: UiGraph,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): Record<string, unknown> {
  const key = getUiGraphChatStorageKey(uiGraph, location);
  if (!key || !storage) {
    return {};
  }

  try {
    const serializedState = storage.getItem(key);
    if (!serializedState) {
      return {};
    }

    const storedState: unknown = JSON.parse(serializedState);
    return isRecord(storedState) ? getUiGraphChatPersistentState(uiGraph, storedState) : {};
  } catch {
    return {};
  }
}

/** Persists only Chat draft, conversation, and pins for the current browser app URL. */
export function saveUiGraphChatPersistentState(
  uiGraph: UiGraph,
  state: Readonly<Record<string, unknown>>,
  storage: UiGraphBrowserStorage | undefined = getDefaultUiGraphBrowserStorage(),
  location?: UiGraphStorageLocation,
): void {
  purgeDisabledUiGraphResponseTraces(uiGraph, storage, location);
  const key = getUiGraphChatStorageKey(uiGraph, location);
  if (!key || !storage) {
    return;
  }

  try {
    const persistentState = getUiGraphChatPersistentState(uiGraph, state);
    if (Object.keys(persistentState).length === 0) {
      storage.removeItem(key);
      return;
    }

    const serializedState = JSON.stringify(persistentState);
    if (storage.getItem(key) !== serializedState) {
      storage.setItem(key, serializedState);
    }
  } catch {
    // Storage can be unavailable, full, or blocked; Chat itself still works.
  }
}

/**
 * Limits an expanded Output card's native resize range to one visible content
 * line through its rendered value. Short, naturally-sized outputs have no resize
 * handle because resizing them would only add blank space.
 */
export function observeUiGraphOutputResizeBounds(output: HTMLElement): () => void {
  const ownerWindow = output.ownerDocument.defaultView;
  let scheduledFrame: number | undefined;

  const sync = () => {
    scheduledFrame = undefined;
    if (!ownerWindow) return;
    const header = output.querySelector<HTMLElement>('.rivet-web-app-output-header');
    const content = output.querySelector<HTMLElement>('.rivet-web-app-output-content');
    const body = output.querySelector<HTMLElement>('.rivet-web-app-output-content-body');

    if (!header || !content || !body) {
      output.classList.remove('rivet-web-app-output-resizable');
      output.classList.remove('rivet-web-app-output-scrollable');
      output.style.removeProperty(OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY);
      output.style.removeProperty(OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY);
      return;
    }

    const bodyStyle = ownerWindow.getComputedStyle(body);
    const lineHeight = getPixelValue(bodyStyle.lineHeight, getPixelValue(bodyStyle.fontSize, 16) * 1.5);
    const contentStyle = ownerWindow.getComputedStyle(content);
    const contentPadding = getPixelValue(contentStyle.paddingTop, 0) + getPixelValue(contentStyle.paddingBottom, 0);
    const verticalBorder = Math.max(0, output.offsetHeight - output.clientHeight);
    const minimumHeight = Math.ceil(
      header.getBoundingClientRect().height + contentPadding + lineHeight + verticalBorder,
    );
    const naturalHeight = Math.ceil(
      header.getBoundingClientRect().height + contentPadding + Math.max(body.scrollHeight, lineHeight) + verticalBorder,
    );
    const viewportHeight = ownerWindow?.innerHeight ?? OUTPUT_MAX_HEIGHT_PX / OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO;
    const maximumViewportHeight = Math.min(viewportHeight * OUTPUT_MAX_VIEWPORT_HEIGHT_RATIO, OUTPUT_MAX_HEIGHT_PX);

    output.classList.toggle('rivet-web-app-output-resizable', naturalHeight > maximumViewportHeight);
    output.classList.toggle('rivet-web-app-output-scrollable', body.scrollHeight > body.clientHeight);
    setStyleProperty(output, OUTPUT_RESIZE_MIN_HEIGHT_PROPERTY, `${minimumHeight}px`);
    setStyleProperty(output, OUTPUT_RESIZE_MAX_HEIGHT_PROPERTY, `${naturalHeight}px`);
  };

  const scheduleSync = () => {
    if (scheduledFrame != null) return;
    if (ownerWindow?.requestAnimationFrame) {
      scheduledFrame = ownerWindow.requestAnimationFrame(sync);
    } else {
      sync();
    }
  };

  const resizeObserver = ownerWindow?.ResizeObserver ? new ownerWindow.ResizeObserver(scheduleSync) : undefined;
  resizeObserver?.observe(output);

  const mutationObserver = ownerWindow?.MutationObserver ? new ownerWindow.MutationObserver(scheduleSync) : undefined;
  mutationObserver?.observe(output, { childList: true, characterData: true, subtree: true });
  output.addEventListener('load', scheduleSync, true);
  ownerWindow?.addEventListener('resize', scheduleSync);
  sync();

  return () => {
    if (scheduledFrame != null) ownerWindow?.cancelAnimationFrame(scheduledFrame);
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    output.removeEventListener('load', scheduleSync, true);
    ownerWindow?.removeEventListener('resize', scheduleSync);
  };
}

/** Copies rendered web-app output without requiring the modern Clipboard API. */
export async function copyUiGraphText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Preview hosts and non-secure origins may not expose the Clipboard API.
  }

  const textArea = document.createElement('textarea');
  textArea.className = 'rivet-web-app-clipboard-fallback';
  textArea.value = value;
  try {
    document.body.append(textArea);
    textArea.select();
    return document.execCommand?.('copy') ?? false;
  } catch {
    return false;
  } finally {
    textArea.remove();
  }
}

/** Downloads the exact JSON string rendered by a web-app output component. */
export function downloadUiGraphJsonOutput(value: string, appName: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = getUiGraphJsonOutputFilename(appName);
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Adds Rivet-owned Copy and Download controls to sanitized fenced JSON blocks.
 * The Markdown renderer must run first: this helper never accepts or inserts
 * author-provided interactive markup.
 */
export function enhanceUiGraphChatJsonCodeBlocks(root: HTMLElement, appName: string): void {
  const codeBlocks = root.querySelectorAll<HTMLElement>('pre > code.language-json');
  root.classList.toggle('rivet-web-app-chat-markdown-has-json', codeBlocks.length > 0);

  for (const code of codeBlocks) {
    const pre = code.parentElement;
    const existingWrapper = pre?.parentElement;
    if (!pre) {
      continue;
    }
    if (existingWrapper?.classList.contains('rivet-web-app-chat-json-block')) {
      existingWrapper.dataset.rivetChatJsonAppName = appName;
      continue;
    }

    const value = code.textContent ?? '';
    const document = root.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = 'rivet-web-app-chat-json-block';
    wrapper.dataset.rivetChatJsonAppName = appName;
    const actions = document.createElement('div');
    actions.className = 'rivet-web-app-chat-json-actions';
    actions.dataset.rivetChatSearchIgnore = 'true';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'rivet-web-app-output-action-button rivet-web-app-output-copy-button';
    copyButton.title = 'Copy JSON';
    copyButton.setAttribute('aria-label', 'Copy JSON');
    copyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void copyUiGraphText(value);
    });

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'rivet-web-app-output-action-button rivet-web-app-output-download-button';
    downloadButton.title = 'Download JSON';
    downloadButton.setAttribute('aria-label', 'Download JSON');
    downloadButton.addEventListener('click', (event) => {
      event.stopPropagation();
      downloadUiGraphJsonOutput(value, wrapper.dataset.rivetChatJsonAppName ?? appName);
    });

    actions.append(copyButton, downloadButton);
    pre.replaceWith(wrapper);
    wrapper.append(pre, actions);

    const syncScrollableState = () => {
      wrapper.classList.toggle('rivet-web-app-chat-json-block-scrollable', pre.scrollHeight > pre.clientHeight);
    };
    syncScrollableState();
    root.ownerDocument.defaultView?.requestAnimationFrame(syncScrollableState);
  }
}

/**
 * Replaces visible chat-message text matches with safe `<mark>` elements. This
 * operates on rendered Markdown DOM rather than source Markdown, so search
 * follows what the user can actually read.
 */
export function highlightUiGraphChatSearchMatches(
  messagesElement: HTMLElement,
  query: string,
  requestedActiveIndex = 0,
): { activeIndex: number; matches: HTMLElement[] } {
  clearUiGraphChatSearchMatches(messagesElement);

  const searchText = query.trim();
  if (!searchText) {
    return { activeIndex: -1, matches: [] };
  }

  const document = messagesElement.ownerDocument;
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(messagesElement, 4);
  let node = walker.nextNode();
  while (node) {
    if (node.parentElement?.closest('script, style, textarea, [data-rivet-chat-search-ignore]')) {
      node = walker.nextNode();
      continue;
    }

    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  const matches: HTMLElement[] = [];
  for (const textNode of textNodes) {
    const value = textNode.data;
    const ranges: Array<{ end: number; start: number }> = [];
    const expression = new RegExp(escapeRegularExpression(searchText), 'gi');
    for (const match of value.matchAll(expression)) {
      if (match.index != null && match[0]) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    if (ranges.length === 0 || !textNode.parentNode) {
      continue;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const range of ranges) {
      fragment.append(value.slice(cursor, range.start));
      const match = document.createElement('mark');
      match.className = CHAT_SEARCH_MATCH_CLASS;
      match.textContent = value.slice(range.start, range.end);
      fragment.append(match);
      matches.push(match);
      cursor = range.end;
    }
    fragment.append(value.slice(cursor));
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  if (matches.length === 0) {
    return { activeIndex: -1, matches };
  }

  const activeIndex = ((requestedActiveIndex % matches.length) + matches.length) % matches.length;
  matches[activeIndex]?.classList.add(CHAT_SEARCH_ACTIVE_MATCH_CLASS);
  return { activeIndex, matches };
}

/** Removes transient chat-search markup without changing the rendered message text. */
export function clearUiGraphChatSearchMatches(messagesElement: HTMLElement): void {
  for (const match of messagesElement.querySelectorAll<HTMLElement>(`.${CHAT_SEARCH_MATCH_CLASS}`)) {
    match.replaceWith(messagesElement.ownerDocument.createTextNode(match.textContent ?? ''));
  }
  messagesElement.normalize();
}

/** Reveals a rendered message or search match inside the chat's own scroll region. */
export function revealUiGraphChatElement(
  messagesElement: HTMLElement,
  element: HTMLElement | undefined,
  alignment: 'center' | 'start' = 'center',
): void {
  if (!element || !messagesElement.contains(element)) {
    return;
  }

  const containerRect = messagesElement.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const maxScrollTop = Math.max(0, messagesElement.scrollHeight - messagesElement.clientHeight);
  const offset =
    elementRect.top -
    containerRect.top -
    (alignment === 'center' ? (messagesElement.clientHeight - elementRect.height) / 2 : 0);
  messagesElement.scrollTop = Math.max(0, Math.min(maxScrollTop, messagesElement.scrollTop + offset));
}

/** Centers the active chat-search match inside the chat's own scroll region. */
export const revealUiGraphChatSearchMatch = revealUiGraphChatElement;
