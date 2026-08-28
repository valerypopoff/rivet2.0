import {
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
  type WorkflowRecordingInputFilter,
  type WorkflowRecordingInputFilterOperator,
} from '../../../../studio-server-shared/workflow-recording-types.js';

type PathToken = string | number;

const INPUT_FILTER_OPERATORS = new Set<WorkflowRecordingInputFilterOperator>(
  WORKFLOW_RECORDING_INPUT_FILTER_OPERATORS,
);
const INPUT_FILTER_CONCURRENT_ARTIFACT_READS = 8;

type FilterRowsBySerializedRecordingInputPageOptions = {
  cursor: number;
  pageSize: number;
  settleCandidateCount?: number;
  signal?: AbortSignal;
};

type FilterRowsBySerializedRecordingInputPageResult<T> = {
  rows: T[];
  totalRuns: number;
  totalRunsExact: boolean;
  hasMore: boolean;
  nextInputCursor?: number;
};

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
  if (!input.exists) {
    return false;
  }

  return matchesWorkflowRecordingInputFilter(input.value, filter);
}

export async function filterRowsBySerializedRecordingInput<T>(
  rows: T[],
  filter: WorkflowRecordingInputFilter,
  readSerializedRecording: (row: T) => Promise<string | null>,
): Promise<T[]> {
  const matches = Array.from({ length: rows.length }, () => false);
  let nextIndex = 0;

  const workerCount = Math.min(INPUT_FILTER_CONCURRENT_ARTIFACT_READS, rows.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < rows.length) {
      const rowIndex = nextIndex;
      nextIndex += 1;

      try {
        const serializedRecording = await readSerializedRecording(rows[rowIndex]!);
        matches[rowIndex] = serializedRecording != null &&
          matchesWorkflowRecordingSerializedInputFilter(serializedRecording, filter);
      } catch {
        matches[rowIndex] = false;
      }
    }
  }));

  return rows.filter((_, index) => matches[index]);
}

export async function filterRowsBySerializedRecordingInputPage<T>(
  rows: T[],
  filter: WorkflowRecordingInputFilter,
  readSerializedRecording: (row: T) => Promise<string | null>,
  options: FilterRowsBySerializedRecordingInputPageOptions,
): Promise<FilterRowsBySerializedRecordingInputPageResult<T>> {
  const cursor = Math.min(rows.length, Math.max(0, Math.floor(options.cursor)));
  const pageSize = Math.min(100, Math.max(1, Math.floor(options.pageSize)));
  const settleCandidateCount = Math.max(1, Math.floor(options.settleCandidateCount ?? pageSize));
  const pageRows: T[] = [];
  let matchedRows = 0;
  let scannedRows = 0;
  let nextIndex = cursor;
  let pageFilled = false;

  while (nextIndex < rows.length) {
    throwIfAborted(options.signal);

    const batchStartIndex = nextIndex;
    const batchRows = rows.slice(batchStartIndex, batchStartIndex + INPUT_FILTER_CONCURRENT_ARTIFACT_READS);
    nextIndex += batchRows.length;

    const batchMatches = await Promise.all(batchRows.map(async (row) => {
      try {
        throwIfAborted(options.signal);
        const serializedRecording = await readSerializedRecording(row);
        throwIfAborted(options.signal);
        return serializedRecording != null &&
          matchesWorkflowRecordingSerializedInputFilter(serializedRecording, filter);
      } catch {
        return false;
      }
    }));
    throwIfAborted(options.signal);

    for (let index = 0; index < batchRows.length; index += 1) {
      scannedRows += 1;

      if (!batchMatches[index]) {
        continue;
      }

      matchedRows += 1;
      if (pageRows.length < pageSize) {
        pageRows.push(batchRows[index]!);
      }

      if (pageRows.length >= pageSize) {
        pageFilled = true;
        break;
      }
    }

    if (pageFilled) {
      break;
    }

    if (scannedRows >= settleCandidateCount) {
      break;
    }
  }

  const nextInputCursor = cursor + scannedRows;
  const totalRunsExact = nextInputCursor >= rows.length && cursor === 0;
  const hasMore = nextInputCursor < rows.length;

  return {
    rows: pageRows,
    totalRuns: totalRunsExact ? matchedRows : pageRows.length,
    totalRunsExact,
    hasMore,
    nextInputCursor: hasMore ? nextInputCursor : undefined,
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

function extractWorkflowInputFromSerializedRecording(recordingSerialized: string): { exists: boolean; value: unknown } {
  let serialized: unknown;
  try {
    serialized = JSON.parse(recordingSerialized);
  } catch {
    return { exists: false, value: undefined };
  }

  if (serialized == null || typeof serialized !== 'object' || Array.isArray(serialized)) {
    return { exists: false, value: undefined };
  }

  const serializedObject = serialized as Record<string, unknown>;
  const strings = serializedObject.strings != null &&
    typeof serializedObject.strings === 'object' &&
    !Array.isArray(serializedObject.strings)
    ? serializedObject.strings as Record<string, unknown>
    : {};
  const recording = restoreSerializedReferences(serializedObject.recording, strings);

  if (recording == null || typeof recording !== 'object' || Array.isArray(recording)) {
    return { exists: false, value: undefined };
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
    const extractedInput = extractInputPortValue(inputs);
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

  const resolved = readJsonPath(input, filter.path);
  if (filter.operator === 'exists') {
    return resolved.exists;
  }

  if (filter.operator === 'not_exists') {
    return !resolved.exists;
  }

  const expected = parseFilterValue(filter.value);

  switch (filter.operator) {
    case '==':
      return valuesEqual(resolved.value, expected);
    case '!=':
      return !valuesEqual(resolved.value, expected);
    case '>':
      return matchesComparison(resolved.value, expected, (comparison) => comparison > 0);
    case '>=':
      return matchesComparison(resolved.value, expected, (comparison) => comparison >= 0);
    case '<':
      return matchesComparison(resolved.value, expected, (comparison) => comparison < 0);
    case '<=':
      return matchesComparison(resolved.value, expected, (comparison) => comparison <= 0);
    case 'contains':
      return valueContains(resolved.value, expected);
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

function readJsonPath(input: unknown, path: string): { exists: boolean; value: unknown } {
  const tokens = parseJsonPath(path);
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

  if (
    trimmed.length >= 2 &&
    trimmed.startsWith("'") &&
    trimmed.endsWith("'")
  ) {
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

function jsonLikeValuesEqual(left: Record<string, unknown> | unknown[], right: Record<string, unknown> | unknown[]): boolean {
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

  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    valuesEqual(left[key], right[key]));
}

function matchesComparison(
  left: unknown,
  right: unknown,
  predicate: (comparison: number) => boolean,
): boolean {
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
