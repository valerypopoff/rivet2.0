import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';

import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRecordingInputFilter,
  type WorkflowRecordingInputFilterOperator,
} from '../../../../studio-server-shared/workflow-recording-types.js';

type PathToken = string | number;

const INPUT_FILTER_OPERATORS = new Set<WorkflowRecordingInputFilterOperator>(WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS);
const INPUT_FILTER_CONCURRENT_ARTIFACT_READS = 8;

// Start with a small newest-first metadata window, then grow bounded windows
// within the request budget. Both storage backends share this scheduling policy.
export const RECORDING_INPUT_FILTER_CANDIDATE_WINDOW_SIZE = 24;
export const RECORDING_INPUT_FILTER_MAX_CANDIDATE_WINDOW_SIZE = 256;
export const RECORDING_INPUT_FILTER_SCAN_BUDGET_MS = 150;
export const RECORDING_INPUT_PAGE_COMPLETE = Symbol('recording-input-page-complete');

export type WorkflowRecordingExtractedInput = {
  exists: boolean;
  value: unknown;
};

type PreparedWorkflowRecordingInputFilter = {
  operator: WorkflowRecordingInputFilterOperator;
  pathTokens: PathToken[];
  expected: unknown;
};

type FilterRowsByRecordingInputPageOptions<T> = {
  cursor: number;
  pageSize: number;
  settleCandidateCount?: number;
  /** Absolute cursor represented by rows[0] when rows are a metadata window. */
  cursorBase?: number;
  /** Whether a metadata row exists after the supplied window. */
  hasMoreCandidates?: boolean;
  /** Check the newest candidate by itself so a fresh match is returned immediately. */
  probeFirstCandidate?: boolean;
  /**
   * True only for the first request in an input-filter search. A first request
   * may return its first match promptly; continuations fill their page within
   * the response budget instead.
   */
  isInitialSearch?: boolean;
  /** Stop scheduling additional candidates after this short response budget. */
  scanBudgetMs?: number;
  /** Creates the opaque continuation after the final consumed candidate. */
  getInputAfter?: (row: T, nextInputCursor: number) => string | undefined;
  /** Injectable monotonic clock for deterministic scan-budget tests. */
  now?: () => number;
  signal?: AbortSignal;
};

type FilterRowsByRecordingInputPageResult<T> = {
  rows: T[];
  totalRuns: number;
  totalRunsExact: boolean;
  hasMore: boolean;
  analyzedRuns: number;
  nextInputCursor?: number;
  nextInputAfter?: string;
};

/** One HTTP response may consume several bounded keyset windows, never a full history allocation. */
export async function filterRecordingInputWindows<T>(
  filter: WorkflowRecordingInputFilter,
  loadWindow: (after: string | undefined, offset: number, limit: number) => Promise<T[]>,
  readInput: (row: T, signal: AbortSignal) => Promise<WorkflowRecordingExtractedInput | null>,
  options: {
    pageSize: number;
    inputCursor: number;
    inputAfter?: string;
    getInputAfter: (row: T, cursor: number) => string;
    signal?: AbortSignal;
    now?: () => number;
    scanBudgetMs?: number;
  },
): Promise<FilterRowsByRecordingInputPageResult<T>> {
  const now = options.now ?? performance.now.bind(performance);
  const deadline = now() + (options.scanBudgetMs ?? RECORDING_INPUT_FILTER_SCAN_BUDGET_MS);
  const initial = !options.inputAfter && options.inputCursor === 0;
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  let after = options.inputAfter;
  let offset = options.inputCursor;
  let windowSize = Math.max(RECORDING_INPUT_FILTER_CANDIDATE_WINDOW_SIZE, pageSize);
  const matches: T[] = [];
  let result: FilterRowsByRecordingInputPageResult<T>;
  do {
    throwIfAborted(options.signal);
    const fetched = await loadWindow(after, offset, windowSize + 1);
    throwIfAborted(options.signal);
    const rows = fetched.slice(0, windowSize);
    result = await filterRowsByRecordingInputPage(rows, filter, readInput, {
      cursor: 0,
      cursorBase: offset,
      pageSize: pageSize - matches.length,
      hasMoreCandidates: fetched.length > windowSize,
      isInitialSearch: initial,
      probeFirstCandidate: initial && offset === 0,
      getInputAfter: options.getInputAfter,
      scanBudgetMs: Math.max(0, deadline - now()),
      now,
      signal: options.signal,
    });
    matches.push(...result.rows);
    if (
      !result.hasMore ||
      matches.length >= pageSize ||
      (initial && matches.length > 0) ||
      now() >= deadline ||
      result.nextInputCursor !== offset + rows.length ||
      result.nextInputCursor - options.inputCursor >= 4096
    )
      break;
    offset = result.nextInputCursor;
    after = result.nextInputAfter;
    windowSize = Math.min(RECORDING_INPUT_FILTER_MAX_CANDIDATE_WINDOW_SIZE, windowSize * 2);
    // Cached scans can otherwise monopolize the microtask queue and delay cancellation.
    await yieldToRequests();
    if (now() >= deadline) break;
  } while (true);
  return {
    ...result,
    rows: matches,
    totalRuns: matches.length,
    totalRunsExact: initial && !result.hasMore,
  };
}

export function normalizeWorkflowRecordingInputFilter(options: {
  path?: string | null;
  operator?: string | null;
  value?: string | null;
}): WorkflowRecordingInputFilter | null {
  const path = options.path?.trim();
  if (!path) {
    return null;
  }

  const operator = options.operator?.trim() || '==';
  if (!INPUT_FILTER_OPERATORS.has(operator as WorkflowRecordingInputFilterOperator)) {
    throw new Error(`Unsupported recording input filter operator: ${operator}`);
  }

  parseJsonPath(path);
  return {
    path,
    operator: operator as WorkflowRecordingInputFilterOperator,
    value: options.value ?? '',
  };
}

export function matchesWorkflowRecordingSerializedInputFilter(
  recordingSerialized: string,
  filter: WorkflowRecordingInputFilter | null | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  const input = extractWorkflowInputFromSerializedRecording(recordingSerialized);
  if (!input?.exists) {
    return false;
  }

  return matchesWorkflowRecordingInputFilter(input.value, filter);
}

export async function filterRowsBySerializedRecordingInput<T>(
  rows: T[],
  filter: WorkflowRecordingInputFilter,
  readSerializedRecording: (row: T) => Promise<string | null>,
): Promise<T[]> {
  const preparedFilter = prepareWorkflowRecordingInputFilter(filter);
  const matches = Array.from({ length: rows.length }, () => false);
  let nextIndex = 0;

  const workerCount = Math.min(INPUT_FILTER_CONCURRENT_ARTIFACT_READS, rows.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < rows.length) {
        const rowIndex = nextIndex;
        nextIndex += 1;

        const serializedRecording = await readSerializedRecording(rows[rowIndex]!);
        const input =
          serializedRecording == null ? null : extractWorkflowInputFromSerializedRecording(serializedRecording);
        matches[rowIndex] =
          input?.exists === true && matchesPreparedWorkflowRecordingInputFilter(input.value, preparedFilter);
      }
    }),
  );

  return rows.filter((_, index) => matches[index]);
}

export async function filterRowsBySerializedRecordingInputPage<T>(
  rows: T[],
  filter: WorkflowRecordingInputFilter,
  readSerializedRecording: (row: T) => Promise<string | null>,
  options: FilterRowsByRecordingInputPageOptions<T>,
): Promise<FilterRowsByRecordingInputPageResult<T>> {
  return filterRowsByRecordingInputPage(
    rows,
    filter,
    async (row) => {
      const serializedRecording = await readSerializedRecording(row);
      return serializedRecording == null ? null : extractWorkflowInputFromSerializedRecording(serializedRecording);
    },
    options,
  );
}

/**
 * Filters a newest-first metadata window using an already extracted recording input.
 * Storage backends use this to avoid rebuilding every event, asset, and string in a
 * recording before comparing the original graph input.
 */
export async function filterRowsByRecordingInputPage<T>(
  rows: T[],
  filter: WorkflowRecordingInputFilter,
  readRecordingInput: (row: T, signal: AbortSignal) => Promise<WorkflowRecordingExtractedInput | null>,
  options: FilterRowsByRecordingInputPageOptions<T>,
): Promise<FilterRowsByRecordingInputPageResult<T>> {
  const cursor = Math.min(rows.length, Math.max(0, Math.floor(options.cursor)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const settleCandidateCount = Math.min(
    rows.length - cursor,
    Math.max(1, Math.floor(options.settleCandidateCount ?? rows.length)),
  );
  const cursorBase = Math.max(0, Math.floor(options.cursorBase ?? 0));
  const preparedFilter = prepareWorkflowRecordingInputFilter(filter);
  const pageRows: T[] = [];
  let matchedRows = 0;
  let scannedRows = 0;
  let nextIndexToStart = cursor;
  let nextIndexToConsume = cursor;
  let lastScannedRow: T | undefined;
  const scanController = new AbortController();
  const signal = combineAbortSignals(options.signal, scanController.signal);
  const now = options.now ?? performance.now.bind(performance);
  const deadlineAt = now() + Math.max(0, options.scanBudgetMs ?? Number.POSITIVE_INFINITY);
  type CandidateResult = { matches: boolean } | { error: unknown };
  type PendingCandidate = {
    promise: Promise<CandidateResult>;
    settled: boolean;
  };
  const pending = new Map<number, PendingCandidate>();
  let returnInitialMatch = false;

  const startCandidate = (index: number): void => {
    const row = rows[index]!;
    const candidate: PendingCandidate = {
      settled: false,
      promise: Promise.resolve({ matches: false }),
    };
    candidate.promise = (async (): Promise<CandidateResult> => {
      try {
        const input = await readRecordingInput(row, signal);
        return {
          matches: input?.exists === true && matchesPreparedWorkflowRecordingInputFilter(input.value, preparedFilter),
        };
      } catch (error: unknown) {
        // Retain read AND matching errors until their ordered cursor position
        // is consumed. Speculative work must never reject without a handler.
        return { error };
      } finally {
        candidate.settled = true;
      }
    })();
    pending.set(index, candidate);
  };

  const scheduleCandidates = (): void => {
    const maximumPending = Math.min(INPUT_FILTER_CONCURRENT_ARTIFACT_READS, Math.max(1, pageSize - pageRows.length));
    while (
      pending.size < maximumPending &&
      nextIndexToStart < rows.length &&
      nextIndexToStart - cursor < settleCandidateCount &&
      !signal.aborted &&
      now() < deadlineAt
    ) {
      startCandidate(nextIndexToStart);
      nextIndexToStart += 1;
    }
  };

  // A common case is looking for the run that was just made. Checking it before
  // issuing a concurrent batch avoids making its response wait for older, often
  // much larger, recording artifacts to be decompressed and parsed.
  try {
    throwIfAborted(options.signal);
    if (options.probeFirstCandidate && cursor === 0 && nextIndexToStart < rows.length) {
      startCandidate(nextIndexToStart);
      nextIndexToStart += 1;
    } else {
      scheduleCandidates();
    }
    // Admission itself can cross the budget (including metadata I/O). Always
    // decide one candidate rather than returning the identical cursor forever.
    if (pending.size === 0 && nextIndexToStart < rows.length) {
      startCandidate(nextIndexToStart++);
    }

    while (pending.size > 0) {
      throwIfAborted(options.signal);
      const currentIndex = nextIndexToConsume;
      const candidate = pending.get(currentIndex);
      if (!candidate) {
        break;
      }
      // The first result in a fresh search is deliberately allowed to finish
      // after its short scheduling budget. Returning a non-advancing cursor
      // would make the client retry the same oldest candidate forever.
      const result = await candidate.promise;
      pending.delete(currentIndex);
      throwIfAborted(options.signal);
      if ('error' in result) throw result.error;

      const row = rows[currentIndex]!;
      lastScannedRow = row;
      nextIndexToConsume += 1;
      scannedRows += 1;
      if (result.matches) {
        matchedRows += 1;
        pageRows.push(row);
        if (pageRows.length >= pageSize) {
          break;
        }
        if (options.isInitialSearch) {
          returnInitialMatch = true;
        }
      }

      // A fresh search should reveal a nearby result without waiting for
      // older speculative work. Consume only the ordered results that have
      // already settled; a continuation instead keeps filling its page.
      if (returnInitialMatch) {
        const nextCandidate = pending.get(nextIndexToConsume);
        if (!nextCandidate?.settled) {
          break;
        }
        continue;
      }

      // Never start additional artifact reads after the response budget. The
      // current ordered read may have crossed the deadline, but completing it
      // is necessary to advance the cursor safely.
      if (now() >= deadlineAt) {
        if (pending.get(nextIndexToConsume)?.settled) continue;
        break;
      }
      scheduleCandidates();
    }
  } catch (error) {
    scanController.abort();
    throw error;
  } finally {
    // Reads scheduled after the last consumed candidate are speculative. They
    // are independently shared by the cache, so stopping this request cannot
    // cancel another search that still needs the same artifact.
    scanController.abort(RECORDING_INPUT_PAGE_COMPLETE);
  }

  return buildFilteredPageResult(rows, pageRows, matchedRows, scannedRows, cursor, cursorBase, lastScannedRow, options);
}

function buildFilteredPageResult<T>(
  rows: T[],
  pageRows: T[],
  matchedRows: number,
  scannedRows: number,
  cursor: number,
  cursorBase: number,
  lastScannedRow: T | undefined,
  options: FilterRowsByRecordingInputPageOptions<T>,
): FilterRowsByRecordingInputPageResult<T> {
  const nextInputCursor = cursorBase + cursor + scannedRows;
  const hasMore = cursor + scannedRows < rows.length || options.hasMoreCandidates === true;
  const totalRunsExact = !hasMore && options.isInitialSearch === true;

  return {
    rows: pageRows,
    totalRuns: totalRunsExact ? matchedRows : pageRows.length,
    totalRunsExact,
    hasMore,
    analyzedRuns: nextInputCursor,
    nextInputCursor: hasMore ? nextInputCursor : undefined,
    nextInputAfter: hasMore && lastScannedRow ? options.getInputAfter?.(lastScannedRow, nextInputCursor) : undefined,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const error = new Error('Recording input filter search aborted');
  error.name = 'AbortError';
  throw error;
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal != null);
  if (activeSignals.length === 1) return activeSignals[0]!;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(activeSignals);
  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export type WorkflowRecordingInputAfterCursor = {
  createdAt: string;
  recordingId: string;
  /** Numeric continuation progress for legacy-client fallback only. */
  legacyCursor: number;
};

type WorkflowRecordingInputAfterPayload = {
  version: 1 | 2;
  workflowId: string;
  statusFilter: string;
  filterFingerprint: string;
  createdAt: string;
  recordingId: string;
  legacyCursor?: number;
};

export function createWorkflowRecordingInputAfter(
  cursor: WorkflowRecordingInputAfterCursor,
  scope: { workflowId: string; statusFilter: string; filter: WorkflowRecordingInputFilter },
): string {
  const payload: WorkflowRecordingInputAfterPayload = {
    version: 2,
    workflowId: scope.workflowId,
    statusFilter: scope.statusFilter,
    filterFingerprint: getInputFilterFingerprint(scope.filter),
    createdAt: cursor.createdAt,
    recordingId: cursor.recordingId,
    legacyCursor: cursor.legacyCursor,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function parseWorkflowRecordingInputAfter(
  value: string | undefined,
  scope: { workflowId: string; statusFilter: string; filter: WorkflowRecordingInputFilter },
): WorkflowRecordingInputAfterCursor | undefined {
  if (!value) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid recording input search continuation.');
  }
  if (
    payload == null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    ((payload as Partial<WorkflowRecordingInputAfterPayload>).version !== 1 &&
      (payload as Partial<WorkflowRecordingInputAfterPayload>).version !== 2) ||
    (payload as Partial<WorkflowRecordingInputAfterPayload>).workflowId !== scope.workflowId ||
    (payload as Partial<WorkflowRecordingInputAfterPayload>).statusFilter !== scope.statusFilter ||
    (payload as Partial<WorkflowRecordingInputAfterPayload>).filterFingerprint !==
      getInputFilterFingerprint(scope.filter) ||
    typeof (payload as Partial<WorkflowRecordingInputAfterPayload>).createdAt !== 'string' ||
    typeof (payload as Partial<WorkflowRecordingInputAfterPayload>).recordingId !== 'string'
  ) {
    throw new Error('Recording input search continuation does not match this search.');
  }
  const candidate = payload as Partial<WorkflowRecordingInputAfterPayload>;
  const createdAt = candidate.createdAt!;
  const recordingId = candidate.recordingId!;
  const legacyCursorRaw = candidate.version === 2 ? candidate.legacyCursor : 0;
  if (!Number.isFinite(Date.parse(createdAt)) || !recordingId) {
    throw new Error('Invalid recording input search continuation.');
  }
  if (typeof legacyCursorRaw !== 'number' || !Number.isInteger(legacyCursorRaw) || legacyCursorRaw < 0) {
    throw new Error('Invalid recording input search continuation.');
  }
  const legacyCursor = legacyCursorRaw;
  return { createdAt, recordingId, legacyCursor };
}

function getInputFilterFingerprint(filter: WorkflowRecordingInputFilter): string {
  return createHash('sha256')
    .update(JSON.stringify([filter.path, filter.operator, filter.value]))
    .digest('base64url');
}

export function extractWorkflowInputFromSerializedRecording(
  recordingSerialized: string,
): WorkflowRecordingExtractedInput | null {
  let serialized: unknown;
  try {
    serialized = JSON.parse(recordingSerialized);
  } catch {
    return null;
  }

  if (serialized == null || typeof serialized !== 'object' || Array.isArray(serialized)) {
    return null;
  }

  const serializedObject = serialized as Record<string, unknown>;
  const strings =
    serializedObject.strings != null &&
    typeof serializedObject.strings === 'object' &&
    !Array.isArray(serializedObject.strings)
      ? (serializedObject.strings as Record<string, unknown>)
      : {};
  const recording = serializedObject.recording;

  if (recording == null || typeof recording !== 'object' || Array.isArray(recording)) {
    return null;
  }

  const events = (recording as Record<string, unknown>).events;
  if (!Array.isArray(events)) {
    return { exists: false, value: undefined };
  }

  for (const event of events) {
    if (event == null || typeof event !== 'object' || Array.isArray(event)) {
      continue;
    }

    const eventRecord = event as Record<string, unknown>;
    if (eventRecord.type !== 'start' && eventRecord.type !== 'graphStart') {
      continue;
    }

    const data = eventRecord.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }

    const inputs = (data as Record<string, unknown>).inputs;
    // String references are relevant only inside the captured input. Restoring
    // the whole recording here used to deep-copy every event and asset solely
    // to evaluate this one filter.
    const extractedInput = extractInputPortValue(restoreSerializedReferences(inputs, strings));
    if (extractedInput.exists) {
      return extractedInput;
    }
  }

  return { exists: false, value: undefined };
}

export function matchesWorkflowRecordingInputFilter(
  input: unknown,
  filter: WorkflowRecordingInputFilter | null | undefined,
): boolean {
  if (!filter) {
    return true;
  }

  return matchesPreparedWorkflowRecordingInputFilter(input, prepareWorkflowRecordingInputFilter(filter));
}

function prepareWorkflowRecordingInputFilter(
  filter: WorkflowRecordingInputFilter,
): PreparedWorkflowRecordingInputFilter {
  return {
    operator: filter.operator,
    pathTokens: parseJsonPath(filter.path),
    expected: parseFilterValue(filter.value),
  };
}

function matchesPreparedWorkflowRecordingInputFilter(
  input: unknown,
  filter: PreparedWorkflowRecordingInputFilter,
): boolean {
  const resolved = readJsonPath(input, filter.pathTokens);
  if (filter.operator === 'exists') {
    return resolved.exists;
  }

  if (filter.operator === 'not_exists') {
    return !resolved.exists;
  }

  switch (filter.operator) {
    case '==':
      return valuesEqual(resolved.value, filter.expected);
    case '!=':
      return !valuesEqual(resolved.value, filter.expected);
    case '>':
      return matchesComparison(resolved.value, filter.expected, (comparison) => comparison > 0);
    case '>=':
      return matchesComparison(resolved.value, filter.expected, (comparison) => comparison >= 0);
    case '<':
      return matchesComparison(resolved.value, filter.expected, (comparison) => comparison < 0);
    case '<=':
      return matchesComparison(resolved.value, filter.expected, (comparison) => comparison <= 0);
    case 'contains':
      return valueContains(resolved.value, filter.expected);
  }

  return false;
}

function restoreSerializedReferences(value: unknown, strings: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$STRING:')) {
    const stringValue = strings[value.slice('$STRING:'.length)];
    return typeof stringValue === 'string' ? stringValue : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => restoreSerializedReferences(item, strings));
  }

  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreSerializedReferences(item, strings)]),
    );
  }

  return value;
}

function extractInputPortValue(inputs: unknown): { exists: boolean; value: unknown } {
  if (inputs == null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return { exists: false, value: undefined };
  }

  const inputPorts = inputs as Record<string, unknown>;
  const inputPort = inputPorts.input;
  if (inputPort == null || typeof inputPort !== 'object' || Array.isArray(inputPort)) {
    if (Object.prototype.hasOwnProperty.call(inputPorts, 'input')) {
      return { exists: true, value: inputPort };
    }

    return extractNamedInputPortValues(inputPorts);
  }

  if (Object.prototype.hasOwnProperty.call(inputPort, 'value')) {
    return { exists: true, value: (inputPort as Record<string, unknown>).value };
  }

  return { exists: true, value: inputPort };
}

function extractNamedInputPortValues(inputs: Record<string, unknown>): { exists: boolean; value: unknown } {
  const entries = Object.entries(inputs);
  if (entries.length === 0) {
    return { exists: false, value: undefined };
  }

  return {
    exists: true,
    value: Object.fromEntries(entries.map(([key, value]) => [key, extractRecordedInputPortValue(value)])),
  };
}

function extractRecordedInputPortValue(inputPort: unknown): unknown {
  if (
    inputPort != null &&
    typeof inputPort === 'object' &&
    !Array.isArray(inputPort) &&
    Object.prototype.hasOwnProperty.call(inputPort, 'value')
  ) {
    return (inputPort as Record<string, unknown>).value;
  }

  return inputPort;
}

function parseJsonPath(path: string): PathToken[] {
  if (!path.startsWith('$')) {
    throw new Error('Recording input filter path must start with $');
  }

  const tokens: PathToken[] = [];
  let index = 1;

  while (index < path.length) {
    const char = path[index];
    if (char === '.') {
      index += 1;
      const start = index;
      while (index < path.length && /[A-Za-z0-9_$-]/.test(path[index]!)) {
        index += 1;
      }

      if (start === index) {
        throw new Error(`Invalid recording input filter path: ${path}`);
      }

      tokens.push(path.slice(start, index));
      continue;
    }

    if (char === '[') {
      const closeIndex = path.indexOf(']', index);
      if (closeIndex < 0) {
        throw new Error(`Invalid recording input filter path: ${path}`);
      }

      const rawToken = path.slice(index + 1, closeIndex).trim();
      if (/^\d+$/.test(rawToken)) {
        tokens.push(Number(rawToken));
      } else if (
        (rawToken.startsWith('"') && rawToken.endsWith('"')) ||
        (rawToken.startsWith("'") && rawToken.endsWith("'"))
      ) {
        tokens.push(rawToken.slice(1, -1));
      } else {
        throw new Error(`Invalid recording input filter path: ${path}`);
      }

      index = closeIndex + 1;
      continue;
    }

    throw new Error(`Invalid recording input filter path: ${path}`);
  }

  return tokens;
}

function readJsonPath(input: unknown, tokens: PathToken[]): { exists: boolean; value: unknown } {
  let current = input;

  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Array.isArray(current) || token >= current.length) {
        return { exists: false, value: undefined };
      }

      current = current[token];
      continue;
    }

    if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      return { exists: false, value: undefined };
    }

    current = (current as Record<string, unknown>)[token];
  }

  return { exists: true, value: current };
}

function parseFilterValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed === 'undefined') {
    return undefined;
  }

  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (typeof left === 'number' && typeof right === 'string' && right.trim() !== '') {
    return left === Number(right);
  }

  if (typeof left === 'string' && typeof right !== 'object') {
    return left === String(right);
  }

  if (isJsonLikeObject(left) && isJsonLikeObject(right)) {
    return jsonLikeValuesEqual(left, right);
  }

  return false;
}

function isJsonLikeObject(value: unknown): value is Record<string, unknown> | unknown[] {
  return value != null && typeof value === 'object';
}

function jsonLikeValuesEqual(
  left: Record<string, unknown> | unknown[],
  right: Record<string, unknown> | unknown[],
): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => valuesEqual(item, right[index]));
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && valuesEqual(left[key], right[key]),
  );
}

function matchesComparison(left: unknown, right: unknown, predicate: (comparison: number) => boolean): boolean {
  const comparison = compareValues(left, right);
  return comparison != null && predicate(comparison);
}

function compareValues(left: unknown, right: unknown): number | null {
  if (left === undefined || right === undefined) {
    return null;
  }

  const leftNumber = toComparableNumber(left);
  const rightNumber = toComparableNumber(right);
  if (leftNumber != null && rightNumber != null) {
    return leftNumber - rightNumber;
  }

  return String(left).localeCompare(String(right));
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function valueContains(value: unknown, expected: unknown): boolean {
  if (typeof expected === 'string') {
    if (value === undefined) {
      return expected === 'undefined';
    }

    return valueContainsText(value, expected);
  }

  if (typeof value === 'string') {
    return value.includes(String(expected));
  }

  if (Array.isArray(value)) {
    return value.some((item) => valuesEqual(item, expected));
  }

  return false;
}

function valueContainsText(value: unknown, expected: string): boolean {
  if (expected === '') {
    return value !== undefined;
  }

  const visited = new Set<object>();

  return valueContainsTextInner(value, expected, visited);
}

function valueContainsTextInner(value: unknown, expected: string, visited: Set<object>): boolean {
  if (value === undefined) {
    return false;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).includes(expected);
  }

  if (typeof value !== 'object') {
    return String(value).includes(expected);
  }

  if (visited.has(value)) {
    return false;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => valueContainsTextInner(item, expected, visited));
  }

  for (const [key, item] of Object.entries(value)) {
    if (key.includes(expected) || valueContainsTextInner(item, expected, visited)) {
      return true;
    }
  }

  return false;
}
