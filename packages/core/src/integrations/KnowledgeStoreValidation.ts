import type {
  GetKnowledgeSourceStatusResult,
  KnowledgeFilter,
  KnowledgeFilterComparisonOperator,
  KnowledgeMetadata,
  KnowledgeMetadataValue,
  RivetKnowledgeDocument,
  RivetKnowledgeEvidence,
  RivetKnowledgeSourceReference,
  SearchKnowledgeSourceResult,
  SyncKnowledgeSourceResult,
} from './KnowledgeStore.js';

export function normalizeKnowledgeConnectionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error('Knowledge store connection ID cannot be empty.');
  if (id.length > 256) throw new Error('Knowledge store connection ID cannot exceed 256 characters.');
  if (isReservedKnowledgeObjectKey(id)) {
    throw new Error(`Knowledge store connection ID "${id}" is reserved.`);
  }
  return id;
}

export function isReservedKnowledgeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

export function normalizeKnowledgeSourceId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) throw new Error('Knowledge source ID cannot be empty.');
  if (id.length > 512) throw new Error('Knowledge source ID cannot exceed 512 characters.');
  return id;
}

export function normalizeKnowledgeSourceReference(value: unknown): RivetKnowledgeSourceReference {
  if (!isRecord(value)) throw new Error('Knowledge Source must be an object.');
  const connectionId = normalizeKnowledgeConnectionId(value.connectionId);
  const sourceId = normalizeKnowledgeSourceId(value.sourceId);
  const version = normalizeKnowledgeVersion(value.version, 'Knowledge source version');
  return { connectionId, sourceId, ...(version ? { version } : {}) };
}

export function normalizeKnowledgeQueries(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Knowledge queries must be an array.');
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const rawQuery of value) {
    if (typeof rawQuery !== 'string') throw new Error('Knowledge queries must contain only strings.');
    const query = rawQuery.trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push(query);
  }
  if (queries.length === 0) throw new Error('Search Knowledge requires at least one non-empty query.');
  return queries;
}

export function normalizeKnowledgeMetadata(value: unknown, label = 'Knowledge metadata'): KnowledgeMetadata {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${label} must be a plain object.`);

  const normalized: KnowledgeMetadata = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key) throw new Error(`${label} contains an empty field name.`);
    rejectUnsafeObjectKey(key, label);
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      throw new Error(`${label} contains duplicate field "${key}" after trimming.`);
    }
    normalized[key] = normalizeKnowledgeMetadataValue(rawValue, `${label}.${key}`);
  }
  return normalized;
}

export function normalizeKnowledgeDocument(value: unknown, index?: number): RivetKnowledgeDocument {
  const label = index == null ? 'Knowledge document' : `Knowledge document ${index + 1}`;
  if (typeof value === 'string') {
    const text = normalizeDocumentText(value);
    if (!text) throw new Error(`${label} text cannot be empty.`);
    return { text };
  }
  if (!isRecord(value)) throw new Error(`${label} must be a string or object.`);

  const text = normalizeDocumentText(value.text);
  if (!text) throw new Error(`${label} text cannot be empty.`);
  const id = optionalTrimmedString(value.id, `${label} ID`) ?? '';
  const title = optionalTrimmedString(value.title, `${label} title`) ?? '';
  const metadata = value.metadata == null ? undefined : normalizeKnowledgeMetadata(value.metadata, `${label} metadata`);
  return {
    ...(id ? { id } : {}),
    text,
    ...(title ? { title } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function normalizeKnowledgeEvidence(value: unknown): RivetKnowledgeEvidence {
  if (!isRecord(value)) throw new Error('Knowledge Evidence must be an object.');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const text = normalizeDocumentText(value.text);
  const documentId = typeof value.documentId === 'string' ? value.documentId.trim() : '';
  if (!id || !text || !documentId) {
    throw new Error('Knowledge Evidence requires non-empty id, text, and documentId fields.');
  }
  const score = optionalFiniteNumber(value.relevanceScore, 'Knowledge Evidence relevance score');
  const title = optionalTrimmedString(value.title, 'Knowledge Evidence title') ?? '';
  const chunkIndex = optionalNonNegativeInteger(value.chunkIndex, 'Knowledge Evidence chunk index');
  return {
    id,
    text,
    source: normalizeKnowledgeSourceReference(value.source),
    documentId,
    ...(score == null ? {} : { relevanceScore: score }),
    ...(title ? { title } : {}),
    ...(chunkIndex == null ? {} : { chunkIndex }),
    ...(value.metadata == null ? {} : { metadata: normalizeKnowledgeMetadata(value.metadata) }),
  };
}

export function normalizeKnowledgeSourceStatusResult(
  value: unknown,
  expectedSource?: RivetKnowledgeSourceReference,
  expectedVersion?: string,
): GetKnowledgeSourceStatusResult {
  if (!isRecord(value)) throw new Error('Knowledge source status result must be an object.');
  if (typeof value.exists !== 'boolean') throw new Error('Knowledge source status result requires an Exists boolean.');
  const source = normalizeKnowledgeSourceReference(value.source);
  validateExpectedSourceIdentity(source, expectedSource);
  const activeVersion = normalizeKnowledgeVersion(value.activeVersion, 'Knowledge source active version');
  if (activeVersion && source.version && activeVersion !== source.version) {
    throw new Error('Knowledge source status returned conflicting active versions.');
  }
  const resolvedActiveVersion = value.exists ? activeVersion || source.version : activeVersion;
  if (!value.exists && activeVersion) {
    throw new Error('A missing knowledge source status cannot have an active version.');
  }
  const message = requiredString(value.message, 'Knowledge source status message');
  const documentCount = optionalNonNegativeInteger(value.documentCount, 'Knowledge source document count');
  const chunkCount = optionalNonNegativeInteger(value.chunkCount, 'Knowledge source chunk count');
  const updatedAt = optionalTrimmedString(value.updatedAt, 'Knowledge source update time');
  if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) {
    throw new Error('Knowledge source status returned an invalid update time.');
  }
  if (value.matchesExpectedVersion != null && typeof value.matchesExpectedVersion !== 'boolean') {
    throw new Error('Knowledge source status returned an invalid expected-version match value.');
  }
  const requestedVersion =
    normalizeKnowledgeVersion(expectedVersion, 'Expected knowledge source version') ??
    normalizeKnowledgeVersion(expectedSource?.version, 'Expected knowledge source version');
  const matchesExpectedVersion = requestedVersion
    ? value.exists && resolvedActiveVersion === requestedVersion
    : undefined;
  if (
    matchesExpectedVersion != null &&
    typeof value.matchesExpectedVersion === 'boolean' &&
    value.matchesExpectedVersion !== matchesExpectedVersion
  ) {
    throw new Error('Knowledge source status returned an incorrect expected-version match value.');
  }
  const metadata = value.metadata == null ? undefined : normalizeKnowledgeMetadata(value.metadata, 'Source metadata');
  const normalizedFields = {
    message,
    ...(documentCount == null ? {} : { documentCount }),
    ...(chunkCount == null ? {} : { chunkCount }),
    ...(updatedAt ? { updatedAt } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    ...(matchesExpectedVersion != null
      ? { matchesExpectedVersion }
      : typeof value.matchesExpectedVersion === 'boolean'
        ? { matchesExpectedVersion: value.matchesExpectedVersion }
        : {}),
  };
  if (!value.exists) return { ...normalizedFields, exists: false, source };
  if (!resolvedActiveVersion) {
    throw new Error('An existing knowledge source status requires an active version.');
  }
  return {
    ...normalizedFields,
    exists: true,
    source: { ...source, version: resolvedActiveVersion },
    activeVersion: resolvedActiveVersion,
  };
}

export function normalizeSyncKnowledgeSourceResult(
  value: unknown,
  expectedSource?: RivetKnowledgeSourceReference,
): SyncKnowledgeSourceResult {
  if (!isRecord(value)) throw new Error('Knowledge source sync result must be an object.');
  const source = normalizeKnowledgeSourceReference(value.source);
  validateExpectedSourceIdentity(source, expectedSource);
  if (!source.version) throw new Error('Knowledge source sync result requires a committed version.');
  if (value.result !== 'created' && value.result !== 'updated' && value.result !== 'unchanged') {
    throw new Error('Knowledge source sync result has an unsupported result value.');
  }
  const documentCount = requiredPositiveInteger(value.documentCount, 'Knowledge source document count');
  const chunkCount = requiredPositiveInteger(value.chunkCount, 'Knowledge source chunk count');
  const previousVersion = normalizeKnowledgeVersion(value.previousVersion, 'Previous knowledge source version');
  if (!Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === 'string')) {
    throw new Error('Knowledge source sync warnings must be a string array.');
  }
  return {
    source: { ...source, version: source.version },
    result: value.result,
    documentCount,
    chunkCount,
    ...(previousVersion ? { previousVersion } : {}),
    warnings: [...value.warnings],
  };
}

export function normalizeSearchKnowledgeSourceResult(
  value: unknown,
  expectedSource?: RivetKnowledgeSourceReference,
  expectedQueries?: readonly string[],
): SearchKnowledgeSourceResult {
  if (!isRecord(value)) throw new Error('Knowledge search result must be an object.');
  if (typeof value.sourceFound !== 'boolean')
    throw new Error('Knowledge search result requires a Source Found boolean.');
  const source = normalizeKnowledgeSourceReference(value.source);
  validateExpectedSourceIdentity(source, expectedSource);
  if (value.sourceFound && !source.version) {
    throw new Error('A found knowledge source search result requires an active version.');
  }
  if (value.sourceFound && expectedSource?.version && source.version !== expectedSource.version) {
    throw new Error('Knowledge search returned a different version than the exact version requested.');
  }
  if (!Array.isArray(value.evidence)) throw new Error('Knowledge search evidence must be an array.');
  if (!Array.isArray(value.queryResults)) throw new Error('Knowledge query results must be an array.');
  const evidence = value.evidence.map(normalizeKnowledgeEvidence);
  const queryResults = value.queryResults.map((queryResult, index) => {
    if (!isRecord(queryResult)) throw new Error(`Knowledge query result ${index + 1} must be an object.`);
    const query = requiredNonEmptyString(queryResult.query, `Knowledge query result ${index + 1} query`);
    if (!Array.isArray(queryResult.evidence)) {
      throw new Error(`Knowledge query result ${index + 1} evidence must be an array.`);
    }
    return { query, evidence: queryResult.evidence.map(normalizeKnowledgeEvidence) };
  });
  validateUniqueEvidence(evidence, 'Knowledge search evidence');
  for (const [index, queryResult] of queryResults.entries()) {
    validateUniqueEvidence(queryResult.evidence, `Knowledge query result ${index + 1} evidence`);
  }
  const queryEvidenceIds = new Set(queryResults.flatMap((queryResult) => queryResult.evidence.map((item) => item.id)));
  for (const item of evidence) {
    if (!queryEvidenceIds.has(item.id)) {
      throw new Error(`Final knowledge evidence "${item.id}" does not occur in any query result.`);
    }
  }
  for (const item of [...evidence, ...queryResults.flatMap((queryResult) => queryResult.evidence)]) {
    if (!sameKnowledgeSource(item.source, source)) {
      throw new Error(`Knowledge evidence "${item.id}" does not belong to the returned source.`);
    }
  }
  if (!value.sourceFound && (evidence.length > 0 || queryResults.some((result) => result.evidence.length > 0))) {
    throw new Error('A missing knowledge source search result cannot contain evidence.');
  }
  if (expectedQueries) {
    const normalizedExpectedQueries = normalizeKnowledgeQueries([...expectedQueries]);
    const actualQueries = queryResults.map((result) => result.query);
    const expectedResultQueries = value.sourceFound ? normalizedExpectedQueries : [];
    if (
      actualQueries.length !== expectedResultQueries.length ||
      actualQueries.some((query, index) => query !== expectedResultQueries[index])
    ) {
      throw new Error('Knowledge search returned query groups that do not match the requested queries.');
    }
  }
  return {
    sourceFound: value.sourceFound,
    source,
    evidence,
    queryResults,
    message: requiredString(value.message, 'Knowledge search status message'),
  };
}

export function normalizeKnowledgeFilter(value: unknown): KnowledgeFilter {
  if (!isRecord(value)) throw new Error('Knowledge filter must be an object.');
  const branches = [
    Array.isArray(value.and),
    Array.isArray(value.or),
    value.not != null,
    value.field != null || value.operator != null,
  ].filter(Boolean).length;
  if (branches !== 1)
    throw new Error('Knowledge filter objects must contain exactly one comparison, and, or, or not expression.');
  if (Array.isArray(value.and)) {
    if (value.and.length === 0) throw new Error('Knowledge filter "and" groups cannot be empty.');
    return { and: value.and.map(normalizeKnowledgeFilter) };
  }
  if (Array.isArray(value.or)) {
    if (value.or.length === 0) throw new Error('Knowledge filter "or" groups cannot be empty.');
    return { or: value.or.map(normalizeKnowledgeFilter) };
  }
  if (value.not != null) return { not: normalizeKnowledgeFilter(value.not) };

  const field = typeof value.field === 'string' ? value.field.trim() : '';
  const operator = typeof value.operator === 'string' ? value.operator : '';
  const validOperators = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;
  if (!field || !validOperators.includes(operator as (typeof validOperators)[number])) {
    throw new Error('Knowledge filter comparisons require a field and supported operator.');
  }
  rejectUnsafeObjectKey(field, 'Knowledge filter');
  if (operator === 'exists') {
    return { field, operator };
  }
  const normalizedValue = normalizeKnowledgeMetadataValue(value.value, `Filter ${field}`);
  if ((operator === 'in' || operator === 'nin') && !Array.isArray(normalizedValue)) {
    throw new Error(`Knowledge filter operator "${operator}" requires an array value.`);
  }
  if (
    (operator === 'gt' || operator === 'gte' || operator === 'lt' || operator === 'lte') &&
    Array.isArray(normalizedValue)
  ) {
    throw new Error(`Knowledge filter operator "${operator}" requires a scalar value.`);
  }
  return {
    field,
    operator: operator as KnowledgeFilterComparisonOperator,
    value: normalizedValue,
  };
}

export function isKnowledgeSourceReference(value: unknown): value is RivetKnowledgeSourceReference {
  try {
    normalizeKnowledgeSourceReference(value);
    return true;
  } catch {
    return false;
  }
}

export function isKnowledgeDocument(value: unknown): value is RivetKnowledgeDocument {
  try {
    normalizeKnowledgeDocument(value);
    return true;
  } catch {
    return false;
  }
}

export function isKnowledgeEvidence(value: unknown): value is RivetKnowledgeEvidence {
  try {
    normalizeKnowledgeEvidence(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeKnowledgeMetadataValue(value: unknown, label: string): KnowledgeMetadataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value;
    if (value.every((item) => typeof item === 'boolean')) return value;
    if (value.every((item) => typeof item === 'number' && Number.isFinite(item))) return value as number[];
    throw new Error(`${label} arrays must contain only strings, booleans, or finite numbers of one type.`);
  }
  throw new Error(`${label} must be a portable scalar or a homogeneous scalar array.`);
}

function normalizeDocumentText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function optionalTrimmedString(value: unknown, label: string): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeKnowledgeVersion(value: unknown, label: string): string | undefined {
  const version = optionalTrimmedString(value, label);
  if (version && version.length > 512) throw new Error(`${label} cannot exceed 512 characters.`);
  return version;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  const normalized = requiredString(value, label).trim();
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  return normalized;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value as number;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer.`);
  return value as number;
}

function validateUniqueEvidence(evidence: RivetKnowledgeEvidence[], label: string): void {
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id)) throw new Error(`${label} contains duplicate evidence ID "${item.id}".`);
    seen.add(item.id);
  }
}

function sameKnowledgeSource(left: RivetKnowledgeSourceReference, right: RivetKnowledgeSourceReference): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.sourceId === right.sourceId &&
    (left.version ?? '') === (right.version ?? '')
  );
}

function validateExpectedSourceIdentity(
  actual: RivetKnowledgeSourceReference,
  expected: RivetKnowledgeSourceReference | undefined,
): void {
  if (expected && (actual.connectionId !== expected.connectionId || actual.sourceId !== expected.sourceId)) {
    throw new Error('Knowledge store returned a result for a different source.');
  }
}

function rejectUnsafeObjectKey(key: string, label: string): void {
  if (isReservedKnowledgeObjectKey(key)) {
    throw new Error(`${label} field "${key}" is reserved.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
