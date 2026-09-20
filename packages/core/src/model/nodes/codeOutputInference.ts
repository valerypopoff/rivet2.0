import { nanoid } from 'nanoid/non-secure';
import { parse, type FunctionDeclaration, type Node, type ReturnStatement } from 'acorn';
import { buildJsValueInterpolatedSource, getJsValueInterpolationRuntimeContext } from './jsValueInterpolation.js';

export type CodeOutputAnalysis = { readonly valid: true; readonly keys: readonly string[] } | { readonly valid: false };

/** A persisted output-port identity and the returned object property it currently reads. */
export type CodeOutputField = {
  id: string;
  key: string;
};

type CodeOutputData = {
  code: string;
  inferredOutputFields?: CodeOutputField[];
  inferredOutputKeys?: string[];
  inferredOutputRetiredFields?: CodeOutputField[];
  /** Last valid source while the current edit is syntactically incomplete. */
  inferredOutputLastValidCode?: string;
};

type CodeOutputKeyOccurrence = {
  key: string;
  start: number;
  end: number;
};

type CodeOutputSyntaxAnalysis =
  | {
      readonly valid: true;
      readonly keys: readonly string[];
      readonly occurrences: readonly CodeOutputKeyOccurrence[];
      readonly source: string;
    }
  | { readonly valid: false };

const cache = new Map<string, CodeOutputSyntaxAnalysis>();
const MAX_CACHED_SOURCES = 128;
const WRAPPER_PREFIX = 'async function __codeOutputs() {\n';
const TRAVERSAL_BOUNDARIES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
]);

function isAstNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string';
}

type ExplicitObjectProperty = Node & {
  type: 'Property';
  computed: boolean;
  method: boolean;
  kind: string;
  key: Node & { name?: string; value?: unknown };
};

type ExplicitObjectPropertyKey = {
  key: string;
  start: number;
  end: number;
};

function getPropertyKey(property: Node): ExplicitObjectPropertyKey | undefined {
  if (property.type !== 'Property') {
    return undefined;
  }

  const objectProperty = property as ExplicitObjectProperty;
  if (objectProperty.computed || objectProperty.method || objectProperty.kind !== 'init') return undefined;

  const key = objectProperty.key;

  if (key.type === 'Identifier') {
    return { key: key.name!, start: key.start, end: key.end };
  }

  return key.type === 'Literal' && ['string', 'number'].includes(typeof key.value)
    ? { key: String(key.value), start: key.start, end: key.end }
    : undefined;
}

function analyzeCodeOutputSyntax(code: string): CodeOutputSyntaxAnalysis {
  const cached = cache.get(code);
  if (cached) {
    return cached;
  }

  let result: CodeOutputSyntaxAnalysis;
  try {
    const source = buildJsValueInterpolatedSource(
      code,
      getJsValueInterpolationRuntimeContext(code, '__codeOutputInputs'),
      { trim: false },
    );
    const tree = parse(`${WRAPPER_PREFIX}${source}\n}`, { ecmaVersion: 'latest' });
    const keys = new Set<string>();
    const occurrences: CodeOutputKeyOccurrence[] = [];
    const visit = (node: Node) => {
      if (TRAVERSAL_BOUNDARIES.has(node.type)) return;

      if (node.type === 'ReturnStatement') {
        const argument = (node as ReturnStatement).argument;
        if (argument?.type === 'ObjectExpression') {
          for (const property of argument.properties) {
            const key = getPropertyKey(property as Node);
            if (key === undefined) continue;

            keys.add(key.key);
            occurrences.push({
              key: key.key,
              start: key.start - WRAPPER_PREFIX.length,
              end: key.end - WRAPPER_PREFIX.length,
            });
          }
        }
        return;
      }

      for (const value of Object.values(node) as unknown[]) {
        if (Array.isArray(value)) {
          for (const child of value) if (isAstNode(child)) visit(child);
        } else if (isAstNode(value)) {
          visit(value);
        }
      }
    };

    // Enter only the wrapper body; nested functions remain traversal boundaries.
    visit((tree.body[0] as FunctionDeclaration).body);
    result = Object.freeze({
      valid: true,
      keys: Object.freeze([...keys]),
      occurrences: Object.freeze(occurrences.map((occurrence) => Object.freeze(occurrence))),
      source,
    });
  } catch {
    result = Object.freeze({ valid: false });
  }

  if (cache.size >= MAX_CACHED_SOURCES) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(code, result);
  return result;
}

/** Syntax-only analysis of explicit object returns in the authored function. */
export function analyzeCodeOutputs(code: string): CodeOutputAnalysis {
  const analysis = analyzeCodeOutputSyntax(code);
  return analysis.valid ? Object.freeze({ valid: true, keys: analysis.keys }) : Object.freeze({ valid: false });
}

function sanitizeOutputFields(fieldsToSanitize: readonly CodeOutputField[] | undefined): CodeOutputField[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const fields: CodeOutputField[] = [];

  for (const field of fieldsToSanitize ?? []) {
    if (
      typeof field?.id !== 'string' ||
      !field.id.startsWith('field:') ||
      typeof field.key !== 'string' ||
      seenIds.has(field.id) ||
      seenKeys.has(field.key)
    ) {
      continue;
    }

    seenIds.add(field.id);
    seenKeys.add(field.key);
    fields.push({ id: field.id, key: field.key });
  }

  return fields;
}

function getStoredOutputFields(data: CodeOutputData): CodeOutputField[] {
  return sanitizeOutputFields(data.inferredOutputFields);
}

function getLegacyOutputFields(keys: readonly string[]): CodeOutputField[] {
  return [...new Set(keys.filter((key) => typeof key === 'string'))].map((key) => ({
    id: `field:${key}`,
    key,
  }));
}

/** Resolves the displayed fields and their stable port identities without mutating node data. */
export function getCodeOutputFields(data: CodeOutputData): readonly CodeOutputField[] {
  const analysis = analyzeCodeOutputSyntax(data.code);
  const storedFields = getStoredOutputFields(data);

  if (!analysis.valid) {
    return storedFields.length > 0 ? storedFields : getLegacyOutputFields(data.inferredOutputKeys ?? []);
  }

  const storedFieldByKey = new Map(storedFields.map((field) => [field.key, field]));
  return analysis.keys.map((key) => storedFieldByKey.get(key) ?? { id: `field:${key}`, key });
}

export function getCodeOutputKeys(data: CodeOutputData): readonly string[] {
  return getCodeOutputFields(data).map((field) => field.key);
}

type TextChange = {
  previousStart: number;
  previousEnd: number;
  nextStart: number;
  nextEnd: number;
};

function getSingleTextChange(previous: string, next: string): TextChange | undefined {
  let prefixLength = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefixLength < sharedLength && previous[prefixLength] === next[prefixLength]) {
    prefixLength += 1;
  }

  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > prefixLength && nextEnd > prefixLength && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }

  if (prefixLength === previousEnd && prefixLength === nextEnd) {
    return undefined;
  }

  return {
    previousStart: prefixLength,
    previousEnd,
    nextStart: prefixLength,
    nextEnd,
  };
}

function isChangeWithinOccurrence(start: number, end: number, occurrence: CodeOutputKeyOccurrence): boolean {
  return start >= occurrence.start && end <= occurrence.end;
}

/**
 * A rename is safe only when the complete source change is confined to one
 * explicit property key on each side. This deliberately rejects broad edits.
 */
function getProvenOutputRename(
  previous: CodeOutputSyntaxAnalysis,
  next: CodeOutputSyntaxAnalysis,
): { oldKey: string; newKey: string } | undefined {
  if (!previous.valid || !next.valid) {
    return undefined;
  }

  const previousKeys = new Set(previous.keys);
  const nextKeys = new Set(next.keys);
  const removedKeys = previous.keys.filter((key) => !nextKeys.has(key));
  const addedKeys = next.keys.filter((key) => !previousKeys.has(key));
  if (removedKeys.length !== 1 || addedKeys.length !== 1) {
    return undefined;
  }

  const oldKey = removedKeys[0]!;
  const newKey = addedKeys[0]!;
  const previousOccurrences = previous.occurrences.filter((occurrence) => occurrence.key === oldKey);
  const nextOccurrences = next.occurrences.filter((occurrence) => occurrence.key === newKey);
  if (previousOccurrences.length !== 1 || nextOccurrences.length !== 1) {
    return undefined;
  }

  const change = getSingleTextChange(previous.source, next.source);
  if (!change) {
    return undefined;
  }

  return isChangeWithinOccurrence(change.previousStart, change.previousEnd, previousOccurrences[0]!) &&
    isChangeWithinOccurrence(change.nextStart, change.nextEnd, nextOccurrences[0]!)
    ? { oldKey, newKey }
    : undefined;
}

function createOutputFieldId(usedIds: ReadonlySet<string>): string {
  let id: string;
  do {
    id = `field:${nanoid()}`;
  } while (usedIds.has(id));
  return id;
}

function getPreviousOutputFields(data: CodeOutputData): CodeOutputField[] {
  const storedFields = getStoredOutputFields(data);
  return storedFields.length > 0 ? storedFields : [...getCodeOutputFields(data)];
}

function getRetiredOutputFields(data: CodeOutputData, activeFields: readonly CodeOutputField[]): CodeOutputField[] {
  const activeIds = new Set(activeFields.map((field) => field.id));
  const activeKeys = new Set(activeFields.map((field) => field.key));
  return sanitizeOutputFields(data.inferredOutputRetiredFields).filter(
    (field) => !activeIds.has(field.id) && !activeKeys.has(field.key),
  );
}

const MAX_RETIRED_OUTPUT_FIELDS = 32;

function reconcileOutputFields(
  previous: CodeOutputData,
  nextAnalysis: Extract<CodeOutputSyntaxAnalysis, { valid: true }>,
): { inferredOutputFields: CodeOutputField[]; inferredOutputRetiredFields: CodeOutputField[] } {
  const previousFields = getPreviousOutputFields(previous);
  const previousFieldByKey = new Map(previousFields.map((field) => [field.key, field]));
  const retiredFields = getRetiredOutputFields(previous, previousFields);
  const retiredFieldByKey = new Map(retiredFields.map((field) => [field.key, field]));
  const sourceForRename = previous.inferredOutputLastValidCode ?? previous.code;
  const rename = getProvenOutputRename(analyzeCodeOutputSyntax(sourceForRename), nextAnalysis);
  const usedIds = new Set([...previousFields, ...retiredFields].map((field) => field.id));
  const fields: CodeOutputField[] = [];
  const reusedRetiredKeys = new Set<string>();
  const renamedKeys = new Set<string>();

  for (const key of nextAnalysis.keys) {
    const exactField = previousFieldByKey.get(key);
    if (exactField) {
      fields.push({ ...exactField });
      continue;
    }

    const retiredField = retiredFieldByKey.get(key);
    if (retiredField) {
      fields.push({ ...retiredField });
      reusedRetiredKeys.add(key);
      continue;
    }

    const renamedField = rename?.newKey === key ? previousFieldByKey.get(rename.oldKey) : undefined;
    if (renamedField && rename && !previousFieldByKey.has(key)) {
      fields.push({ id: renamedField.id, key });
      renamedKeys.add(rename.oldKey);
      continue;
    }

    const id = createOutputFieldId(usedIds);
    usedIds.add(id);
    fields.push({ id, key });
  }

  const fieldKeys = new Set(fields.map((field) => field.key));
  const fieldIds = new Set(fields.map((field) => field.id));
  const newlyRetiredFields = previousFields.filter((field) => !fieldKeys.has(field.key) && !renamedKeys.has(field.key));
  const nextRetiredFields = [
    ...retiredFields.filter((field) => !reusedRetiredKeys.has(field.key)),
    ...newlyRetiredFields,
  ]
    .filter(
      (field, index, all) =>
        !fieldIds.has(field.id) && all.findIndex((candidate) => candidate.id === field.id) === index,
    )
    .slice(-MAX_RETIRED_OUTPUT_FIELDS);

  return {
    inferredOutputFields: fields,
    inferredOutputRetiredFields: nextRetiredFields,
  };
}

function getLastValidCode(data: CodeOutputData): string | undefined {
  return analyzeCodeOutputSyntax(data.code).valid ? data.code : data.inferredOutputLastValidCode;
}

function withoutOutputMetadata(
  data: CodeOutputData,
): Omit<
  CodeOutputData,
  'inferredOutputFields' | 'inferredOutputKeys' | 'inferredOutputRetiredFields' | 'inferredOutputLastValidCode'
> {
  const {
    inferredOutputFields: _discardedFields,
    inferredOutputKeys: _discardedKeys,
    inferredOutputRetiredFields: _discardedRetiredFields,
    inferredOutputLastValidCode: _discardedLastValidCode,
    ...dataWithoutOutputMetadata
  } = data;
  return dataWithoutOutputMetadata;
}

/**
 * Prepares persisted output identities as part of an editor transaction.
 * Valid source owns the visible fields. Invalid source retains the last valid
 * identities and source so a completed key-only rename can still be proved.
 */
export function prepareCodeOutputEdit(previous: CodeOutputData, patch: Partial<CodeOutputData>): CodeOutputData {
  const next = { ...previous, ...patch };
  const analysis = analyzeCodeOutputSyntax(next.code);
  const nextWithoutOutputMetadata = withoutOutputMetadata(next);

  if (analysis.valid) {
    const { inferredOutputFields, inferredOutputRetiredFields } = reconcileOutputFields(previous, analysis);
    return {
      ...nextWithoutOutputMetadata,
      inferredOutputFields,
      inferredOutputKeys: inferredOutputFields.map((field) => field.key),
      ...(inferredOutputRetiredFields.length > 0 ? { inferredOutputRetiredFields } : {}),
    };
  }

  const inferredOutputFields = getPreviousOutputFields(previous);
  const inferredOutputRetiredFields = getRetiredOutputFields(previous, inferredOutputFields);
  const lastValidCode = getLastValidCode(previous);
  return {
    ...nextWithoutOutputMetadata,
    inferredOutputFields,
    inferredOutputKeys: inferredOutputFields.map((field) => field.key),
    ...(inferredOutputRetiredFields.length > 0 ? { inferredOutputRetiredFields } : {}),
    ...(lastValidCode ? { inferredOutputLastValidCode: lastValidCode } : {}),
  };
}
