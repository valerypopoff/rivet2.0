import { type GraphId, type NodeGraph } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import * as YAML from 'yaml';
import {
  GRAPH_BUILDER_LIMITS,
  canonicalGraphBuilderAuthoringStringify,
  calculateGraphBuilderDraftDelta,
  compareGraphBuilderStrings,
  GraphBuilderUnifiedDiffError,
  hashGraphBuilderString,
  isNormalizedGraphBuilderVirtualDocumentPath,
  parseGraphBuilderUnifiedDiff,
  parseGraphBuilderDocumentPatchResult,
  parseGraphValidationResult,
  toBoundedGraphBuilderIdentifier,
  type FreshGraphBuilderDocumentPatchResult,
  type GraphBuilderAuthoringProject,
  type GraphBuilderDocumentPatchResult,
  type GraphBuilderProjectDraftDelta,
  type ParsedGraphBuilderUnifiedDiff,
  type GraphDiagnostic,
  type GraphValidationResult,
} from '../../domain/graphBuilder/index.js';
import { isGraphBuilderSecretFieldName } from './authoringCatalog.js';

export const GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_VERSION = 1 as const;
export const GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_DIRECTORY = 'graphs';
export const GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_SUFFIX = '.yaml';
export const GRAPH_BUILDER_SECRET_PLACEHOLDER_KEY = '$graphBuilderSecret';

const VIRTUAL_WORKSPACE_RULES_VERSION = 'graph-builder-virtual-workspace-v1';
const MAX_RETAINED_PATCH_IDENTITIES = 128;
const MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_VIRTUAL_GRAPH_READ_LINES = 2_000;
const MAX_VIRTUAL_GRAPH_READ_BYTES = 12 * 1024;
const MAX_POLICY_ACTIVE_DOCUMENT_LINES = 2_000;
const MAX_POLICY_ACTIVE_DOCUMENT_BYTES = 64 * 1024;
const SAFE_SECRET_LOOKUP_POLICY_FIELDS = new Set([
  'apikeyenvvarname',
  'apikeyprogrammaticname',
  'apikeysource',
  'customproviderapikeyenvvarname',
  'customproviderapikeyprogrammaticname',
]);

type AuthoringProject = GraphBuilderAuthoringProject;
type SecretPathSegment = string | number;

type SecretPlaceholder = {
  [GRAPH_BUILDER_SECRET_PLACEHOLDER_KEY]: string;
};

type SecretSlot = {
  locator: string;
  ownerNodeId?: string;
  placeholder: SecretPlaceholder;
  value: unknown;
};

type InternalVirtualGraphDocument = {
  contents: string;
  digest: string;
  graphId: GraphId;
  lineOffsets: readonly number[];
  path: string;
  secretSlots: Map<string, SecretSlot>;
};

type TextLine = {
  text: string;
  hasNewline: boolean;
};

type PatchLedgerEntry = {
  canonicalPatch: string;
  result: FreshGraphBuilderDocumentPatchResult;
};

type ResolvedVirtualGraphDocumentEdit = {
  document: InternalVirtualGraphDocument;
  editedContents: string;
};

export type VirtualGraphDocumentDescriptor = Readonly<{
  digest: string;
  draftRevision: number;
  graphId: GraphId;
  lineCount: number;
  path: string;
}>;

export type VirtualGraphDocumentRead = VirtualGraphDocumentDescriptor &
  Readonly<{
    contents: string;
    endOffset: number;
    lineCount: number;
    nextOffset?: number;
    startOffset: number;
    startLine: number;
    totalLength: number;
    totalLineCount: number;
    truncated: boolean;
  }>;

export type VirtualGraphPolicyWorkspaceContext = Readonly<{
  version: 1;
  activeDocumentPath: string;
  delta: GraphBuilderProjectDraftDelta;
  documents: Array<{
    path: string;
    graphId: string;
    name: string;
    digest: string;
    totalLength: number;
    totalLines: number;
    access: 'editable';
  }>;
  activeDocument: {
    path: string;
    digest: string;
    startOffset: number;
    endOffset: number;
    totalLength: number;
    nextOffset?: number;
    totalLines: number;
    startLine: number;
    endLine: number;
    content: string;
    truncated: boolean;
  };
}>;

export type VirtualGraphWorkspaceNormalizationInput = Readonly<{
  base: AuthoringProject;
  candidate: AuthoringProject;
  changedGraphIds: readonly GraphId[];
  current: AuthoringProject;
}>;

export type VirtualGraphWorkspaceValidationInput = Readonly<{
  base: AuthoringProject;
  candidate: AuthoringProject;
  changedGraphIds: readonly GraphId[];
  current: AuthoringProject;
}>;

export type VirtualGraphWorkspaceOptions = Readonly<{
  project: AuthoringProject;
  initialDraftRevision?: number;
  isSecretLikeKey?: (key: string) => boolean;
  normalizeCandidate?: (input: VirtualGraphWorkspaceNormalizationInput) => AuthoringProject;
  validateCandidate?: (input: VirtualGraphWorkspaceValidationInput) => GraphValidationResult;
}>;

export type ApplyVirtualGraphUnifiedDiffInput = Readonly<{
  expectedDraftRevision: number;
  patchId: string;
  unifiedDiff: string;
}>;

export type ReplaceVirtualGraphDocumentInput = Readonly<{
  contents: string;
  expectedDraftRevision: number;
  patchId: string;
  path: string;
}>;

export type VirtualGraphWorkspaceErrorCode =
  | 'invalid-project'
  | 'invalid-document-path'
  | 'unknown-document'
  | 'invalid-read-window'
  | 'invalid-unified-diff'
  | 'diff-context-mismatch'
  | 'invalid-graph-document'
  | 'secret-placeholder-mismatch'
  | 'patch-identity-content-mismatch';

export class VirtualGraphWorkspaceError extends Error {
  readonly code: VirtualGraphWorkspaceErrorCode;
  readonly path?: string;

  constructor(
    code: VirtualGraphWorkspaceErrorCode,
    message: string,
    options: {
      cause?: unknown;
      path?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VirtualGraphWorkspaceError';
    this.code = code;
    this.path = options.path;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizedVirtualDocumentPath(path: string): string {
  if (typeof path !== 'string' || !isNormalizedGraphBuilderVirtualDocumentPath(path)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-document-path',
      `Virtual graph document path "${path}" is not a normalized relative path.`,
      { path },
    );
  }
  return path;
}

function encodedGraphId(graphId: GraphId): string {
  return encodeURIComponent(graphId);
}

export function getVirtualGraphDocumentPath(graphId: GraphId): string {
  return `${GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_DIRECTORY}/${encodedGraphId(graphId)}${GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_SUFFIX}`;
}

function buildLineOffsets(contents: string): number[] {
  if (contents.length === 0) {
    return [];
  }
  const offsets = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === '\n' && index + 1 < contents.length) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function splitTextLines(contents: string): TextLine[] {
  if (contents.length === 0) {
    return [];
  }
  const rawLines = contents.split('\n');
  const endsWithNewline = rawLines.at(-1) === '';
  if (endsWithNewline) {
    rawLines.pop();
  }
  return rawLines.map((text, index) => ({
    text,
    hasNewline: index < rawLines.length - 1 || endsWithNewline,
  }));
}

function joinTextLines(lines: readonly TextLine[]): string {
  return lines.map((line) => `${line.text}${line.hasNewline ? '\n' : ''}`).join('');
}

function lineNumberAtOffset(lineOffsets: readonly number[], offset: number): number {
  let lower = 0;
  let upper = lineOffsets.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (lineOffsets[middle]! <= offset) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return Math.max(1, lower);
}

function unicodePrefix(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join('');
}

function boundedDocumentWindow(
  contents: string,
  lineOffsets: readonly number[],
  startLine: number,
  maxLines: number,
  maxBytes: number,
  startOffset?: number,
): {
  contents: string;
  endOffset: number;
  endLine: number;
  lineCount: number;
  nextOffset?: number;
  startOffset: number;
  totalLength: number;
  totalLineCount: number;
  truncated: boolean;
} {
  const resolvedStartOffset = startOffset ?? lineOffsets[startLine - 1] ?? contents.length;
  const resolvedStartLine =
    startOffset === undefined ? startLine : lineNumberAtOffset(lineOffsets, resolvedStartOffset);
  const requestedEndLine = Math.min(lineOffsets.length, resolvedStartLine - 1 + maxLines);
  const requestedEndOffset = requestedEndLine >= lineOffsets.length ? contents.length : lineOffsets[requestedEndLine]!;
  let windowContents = '';
  let windowByteLength = 0;
  let endOffset = resolvedStartOffset;

  while (endOffset < requestedEndOffset) {
    const codePoint = contents.codePointAt(endOffset);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    const remainingBytes = maxBytes - windowByteLength;
    if (remainingBytes <= 0) {
      break;
    }
    const characterByteLength = utf8ByteLength(character);
    if (characterByteLength > remainingBytes) {
      break;
    }
    windowContents += character;
    windowByteLength += characterByteLength;
    endOffset += character.length;
  }

  const lineCount =
    windowContents.length === 0 ? 0 : windowContents.split('\n').length - (windowContents.endsWith('\n') ? 1 : 0);
  const touchedLineCount = Math.max(lineCount, windowContents.length > 0 && !windowContents.endsWith('\n') ? 1 : 0);
  const nextOffset = endOffset < contents.length ? endOffset : undefined;
  return {
    contents: windowContents,
    endOffset,
    endLine: resolvedStartLine + touchedLineCount - 1,
    lineCount: touchedLineCount,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    startOffset: resolvedStartOffset,
    totalLength: contents.length,
    totalLineCount: lineOffsets.length,
    truncated: resolvedStartOffset > 0 || endOffset < contents.length,
  };
}

function secretLocator(path: readonly SecretPathSegment[]): string {
  return JSON.stringify(path);
}

function createSecretPlaceholder(locator: string): SecretPlaceholder {
  return {
    [GRAPH_BUILDER_SECRET_PLACEHOLDER_KEY]: `host-secret:${hashGraphBuilderString(locator)}`,
  };
}

function isExactSecretPlaceholder(value: unknown, expected: SecretPlaceholder): boolean {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    value[GRAPH_BUILDER_SECRET_PLACEHOLDER_KEY] === expected[GRAPH_BUILDER_SECRET_PLACEHOLDER_KEY]
  );
}

function isInertSecretLikeValue(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isPlainRecord(value) && Object.keys(value).length === 0)
  );
}

export function shouldProtectVirtualGraphSecretField(
  key: string,
  value: unknown,
  isSecretLikeKey: (candidateKey: string) => boolean = isGraphBuilderSecretFieldName,
): boolean {
  if (!isSecretLikeKey(key)) {
    return false;
  }
  const compactKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (
    (typeof value === 'string' && SAFE_SECRET_LOOKUP_POLICY_FIELDS.has(compactKey)) ||
    (typeof value === 'boolean' && compactKey.startsWith('use') && compactKey.endsWith('input'))
  ) {
    return false;
  }
  return !isInertSecretLikeValue(value);
}

function connectionLocator(connection: Record<string, unknown>, index: number): string {
  return JSON.stringify([
    connection.outputNodeId ?? '',
    connection.outputId ?? '',
    connection.inputNodeId ?? '',
    connection.inputId ?? '',
    index,
  ]);
}

function visitSecretLikeFields(
  value: unknown,
  path: readonly SecretPathSegment[],
  isSecretLikeKey: (key: string) => boolean,
  visitor: (input: {
    key: string;
    locator: string;
    ownerNodeId?: string;
    record: Record<string, unknown>;
    value: unknown;
  }) => void,
  ownerNodeId?: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitSecretLikeFields(entry, [...path, index], isSecretLikeKey, visitor, ownerNodeId),
    );
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }

  for (const key of Object.keys(value).sort()) {
    const childPath = [...path, key];
    const child = value[key];
    if (shouldProtectVirtualGraphSecretField(key, child, isSecretLikeKey)) {
      visitor({
        key,
        locator: secretLocator(childPath),
        ownerNodeId,
        record: value,
        value: child,
      });
      continue;
    }
    visitSecretLikeFields(child, childPath, isSecretLikeKey, visitor, ownerNodeId);
  }
}

function visitGraphSecretLikeFields(
  graph: NodeGraph,
  isSecretLikeKey: (key: string) => boolean,
  visitor: Parameters<typeof visitSecretLikeFields>[3],
): void {
  visitSecretLikeFields(graph.metadata, ['metadata'], isSecretLikeKey, visitor);

  const duplicateCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    const occurrence = duplicateCounts.get(node.id) ?? 0;
    duplicateCounts.set(node.id, occurrence + 1);
    visitSecretLikeFields(node, ['nodes', node.id, occurrence], isSecretLikeKey, visitor, node.id);
  }

  graph.connections.forEach((connection, index) => {
    visitSecretLikeFields(
      connection,
      ['connections', connectionLocator(connection as unknown as Record<string, unknown>, index)],
      isSecretLikeKey,
      visitor,
    );
  });

  const graphRecord = graph as unknown as Record<string, unknown>;
  for (const key of Object.keys(graphRecord).sort()) {
    if (key === 'metadata' || key === 'nodes' || key === 'connections') {
      continue;
    }
    visitSecretLikeFields(graphRecord[key], ['graph', key], isSecretLikeKey, visitor);
  }
}

function redactGraphSecrets(
  graph: NodeGraph,
  isSecretLikeKey: (key: string) => boolean,
): {
  graph: NodeGraph;
  secretSlots: Map<string, SecretSlot>;
} {
  const redacted = cloneDeep(graph);
  const secretSlots = new Map<string, SecretSlot>();
  visitGraphSecretLikeFields(redacted, isSecretLikeKey, ({ key, locator, ownerNodeId, record, value }) => {
    const placeholder = createSecretPlaceholder(locator);
    secretSlots.set(locator, {
      locator,
      ...(ownerNodeId === undefined ? {} : { ownerNodeId }),
      placeholder,
      value: cloneDeep(value),
    });
    record[key] = cloneDeep(placeholder);
  });
  return { graph: redacted, secretSlots };
}

function restoreGraphSecrets(
  graph: NodeGraph,
  secretSlots: ReadonlyMap<string, SecretSlot>,
  isSecretLikeKey: (key: string) => boolean,
  path: string,
): NodeGraph {
  const restored = cloneDeep(graph);
  const seen = new Set<string>();
  visitGraphSecretLikeFields(restored, isSecretLikeKey, ({ key, locator, record, value }) => {
    const slot = secretSlots.get(locator);
    if (!slot) {
      throw new VirtualGraphWorkspaceError(
        'secret-placeholder-mismatch',
        `Virtual graph document "${path}" introduced a new secret-like field at ${locator}.`,
        { path },
      );
    }
    if (!isExactSecretPlaceholder(value, slot.placeholder)) {
      throw new VirtualGraphWorkspaceError(
        'secret-placeholder-mismatch',
        `Virtual graph document "${path}" changed the host-owned secret placeholder at ${locator}.`,
        { path },
      );
    }
    record[key] = cloneDeep(slot.value);
    seen.add(locator);
  });

  const survivingNodeIds = new Set<string>(restored.nodes.map((node) => node.id));
  for (const slot of secretSlots.values()) {
    if (seen.has(slot.locator)) {
      continue;
    }
    if (slot.ownerNodeId !== undefined && !survivingNodeIds.has(slot.ownerNodeId)) {
      continue;
    }
    throw new VirtualGraphWorkspaceError(
      'secret-placeholder-mismatch',
      `Virtual graph document "${path}" removed the host-owned secret placeholder at ${slot.locator}.`,
      { path },
    );
  }
  return restored;
}

function canonicalVirtualGraphContents(
  graph: NodeGraph,
  isSecretLikeKey: (key: string) => boolean,
): {
  contents: string;
  secretSlots: Map<string, SecretSlot>;
} {
  const redacted = redactGraphSecrets(graph, isSecretLikeKey);
  const canonicalGraph = JSON.parse(canonicalGraphBuilderAuthoringStringify(redacted.graph)) as Record<string, unknown>;
  const orderedGraph: Record<string, unknown> = {};
  for (const key of ['metadata', 'nodes', 'connections']) {
    if (Object.hasOwn(canonicalGraph, key)) {
      orderedGraph[key] = canonicalGraph[key];
    }
  }
  for (const key of Object.keys(canonicalGraph).sort()) {
    if (!Object.hasOwn(orderedGraph, key)) {
      orderedGraph[key] = canonicalGraph[key];
    }
  }
  const contents = YAML.stringify(
    {
      version: GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_VERSION,
      graph: orderedGraph,
    },
    null,
    { indent: 2, lineWidth: 0 },
  );
  if (utf8ByteLength(contents) > MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES) {
    throw new VirtualGraphWorkspaceError(
      'invalid-project',
      `Virtual graph document exceeds the ${MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES}-byte internal workspace limit.`,
    );
  }
  return { contents, secretSlots: redacted.secretSlots };
}

function invalidVirtualNode(path: string, index: number, detail: string): never {
  throw new VirtualGraphWorkspaceError(
    'invalid-graph-document',
    `Virtual graph document "${path}" has an invalid node at index ${index}: ${detail}.`,
    { path },
  );
}

function isSafeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertVirtualNodeEnvelope(
  node: unknown,
  index: number,
  path: string,
): asserts node is NodeGraph['nodes'][number] {
  if (!isPlainRecord(node)) {
    invalidVirtualNode(path, index, 'the node envelope must be an object');
  }
  if (typeof node.id !== 'string' || node.id.length === 0) {
    invalidVirtualNode(path, index, '"id" must be a non-empty string');
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    invalidVirtualNode(path, index, '"type" must be a non-empty string');
  }
  if (typeof node.title !== 'string') {
    invalidVirtualNode(path, index, '"title" must be a string');
  }
  if (!Object.hasOwn(node, 'data')) {
    invalidVirtualNode(path, index, '"data" is required');
  }
  if (node.description !== undefined && typeof node.description !== 'string') {
    invalidVirtualNode(path, index, '"description" must be a string when present');
  }

  for (const field of ['disabled', 'isConditional', 'isSplitRun', 'isSplitSequential'] as const) {
    if (node[field] !== undefined && typeof node[field] !== 'boolean') {
      invalidVirtualNode(path, index, `"${field}" must be a boolean when present`);
    }
  }
  for (const field of ['splitRunMax', 'splitRunConcurrency'] as const) {
    if (node[field] !== undefined && !isPositiveSafeInteger(node[field])) {
      invalidVirtualNode(path, index, `"${field}" must be a positive safe integer when present`);
    }
  }

  if (!isPlainRecord(node.visualData)) {
    invalidVirtualNode(path, index, '"visualData" must be an object');
  }
  if (!isSafeFiniteNumber(node.visualData.x) || !isSafeFiniteNumber(node.visualData.y)) {
    invalidVirtualNode(path, index, '"visualData.x" and "visualData.y" must be finite safe numbers');
  }
  if (
    node.visualData.width !== undefined &&
    (!isSafeFiniteNumber(node.visualData.width) || node.visualData.width <= 0)
  ) {
    invalidVirtualNode(path, index, '"visualData.width" must be a positive finite safe number when present');
  }
  if (node.visualData.zIndex !== undefined && !Number.isSafeInteger(node.visualData.zIndex)) {
    invalidVirtualNode(path, index, '"visualData.zIndex" must be a safe integer when present');
  }
  if (node.visualData.color !== undefined) {
    if (
      !isPlainRecord(node.visualData.color) ||
      typeof node.visualData.color.border !== 'string' ||
      typeof node.visualData.color.bg !== 'string'
    ) {
      invalidVirtualNode(path, index, '"visualData.color" must contain string "border" and "bg" values');
    }
  }

  if (node.variants !== undefined) {
    if (!Array.isArray(node.variants)) {
      invalidVirtualNode(path, index, '"variants" must be an array when present');
    }
    const variantIds = new Set<string>();
    node.variants.forEach((variant, variantIndex) => {
      if (
        !isPlainRecord(variant) ||
        typeof variant.id !== 'string' ||
        variant.id.length === 0 ||
        !Object.hasOwn(variant, 'data')
      ) {
        invalidVirtualNode(
          path,
          index,
          `"variants[${variantIndex}]" must contain a non-empty string "id" and a "data" value`,
        );
      }
      if (variantIds.has(variant.id)) {
        invalidVirtualNode(path, index, `"variants[${variantIndex}].id" must be unique`);
      }
      variantIds.add(variant.id);
    });
  }

}

function assertVirtualGraphShape(value: unknown, graphId: GraphId, path: string): asserts value is NodeGraph {
  if (!isPlainRecord(value)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must contain a graph object.`,
      { path },
    );
  }
  if (!isPlainRecord(value.metadata)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" is missing graph metadata.`,
      { path },
    );
  }
  if (value.metadata.id !== graphId) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must retain graph ID "${graphId}".`,
      { path },
    );
  }
  if (!Array.isArray(value.nodes)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must contain a nodes array.`,
      { path },
    );
  }
  if (!Array.isArray(value.connections)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must contain a connections array.`,
      { path },
    );
  }

  value.nodes.forEach((node, index) => {
    assertVirtualNodeEnvelope(node, index, path);
  });

  value.connections.forEach((connection, index) => {
    if (
      !isPlainRecord(connection) ||
      typeof connection.outputNodeId !== 'string' ||
      typeof connection.outputId !== 'string' ||
      typeof connection.inputNodeId !== 'string' ||
      typeof connection.inputId !== 'string'
    ) {
      throw new VirtualGraphWorkspaceError(
        'invalid-graph-document',
        `Virtual graph document "${path}" has an invalid connection at index ${index}.`,
        { path },
      );
    }
    if (
      connection.bendPoint !== undefined &&
      (!isPlainRecord(connection.bendPoint) ||
        typeof connection.bendPoint.x !== 'number' ||
        !Number.isFinite(connection.bendPoint.x) ||
        typeof connection.bendPoint.y !== 'number' ||
        !Number.isFinite(connection.bendPoint.y))
    ) {
      throw new VirtualGraphWorkspaceError(
        'invalid-graph-document',
        `Virtual graph document "${path}" has an invalid bend point at connection index ${index}.`,
        { path },
      );
    }
  });
}

function parseVirtualGraphContents(
  contents: string,
  graphId: GraphId,
  path: string,
  secretSlots: ReadonlyMap<string, SecretSlot>,
  isSecretLikeKey: (key: string) => boolean,
): NodeGraph {
  if (utf8ByteLength(contents) > MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" exceeds the ${MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES}-byte internal limit.`,
      { path },
    );
  }

  let documents: YAML.Document.Parsed[];
  try {
    documents = YAML.parseAllDocuments(contents, {
      merge: false,
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch (cause) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause, path },
    );
  }
  if (documents.length !== 1) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must contain exactly one YAML document.`,
      { path },
    );
  }
  const document = documents[0]!;
  if (document.errors.length > 0) {
    const detail = document.errors.map((error) => error.message).join('; ');
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" is not valid YAML: ${detail}`,
      { cause: document.errors[0], path },
    );
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({ maxAliasCount: 0 });
    canonicalGraphBuilderAuthoringStringify(parsed);
  } catch (cause) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" is not bounded data-only YAML: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause, path },
    );
  }
  if (
    !isPlainRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== 'version' && key !== 'graph') ||
    parsed.version !== GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_VERSION
  ) {
    throw new VirtualGraphWorkspaceError(
      'invalid-graph-document',
      `Virtual graph document "${path}" must use version ${GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_VERSION} and contain only its graph.`,
      { path },
    );
  }
  assertVirtualGraphShape(parsed.graph, graphId, path);
  return restoreGraphSecrets(parsed.graph, secretSlots, isSecretLikeKey, path);
}

function parseVirtualGraphUnifiedDiff(unifiedDiff: string): ParsedGraphBuilderUnifiedDiff {
  try {
    return parseGraphBuilderUnifiedDiff(unifiedDiff);
  } catch (cause) {
    if (cause instanceof GraphBuilderUnifiedDiffError) {
      throw new VirtualGraphWorkspaceError('invalid-unified-diff', cause.message, {
        cause,
        ...(cause.path === undefined ? {} : { path: cause.path }),
      });
    }
    throw cause;
  }
}

function sourceHunkIndex(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

function applyParsedUnifiedDiff(baseContents: string, diff: ParsedGraphBuilderUnifiedDiff): string {
  const source = splitTextLines(baseContents);
  const output: TextLine[] = [];
  let sourceIndex = 0;

  for (const [hunkIndex, hunk] of diff.hunks.entries()) {
    const expectedSourceIndex = sourceHunkIndex(hunk.oldStart, hunk.oldCount);
    const expectedOutputIndex = sourceHunkIndex(hunk.newStart, hunk.newCount);
    if (
      expectedSourceIndex < sourceIndex ||
      expectedSourceIndex > source.length ||
      expectedOutputIndex !== output.length + (expectedSourceIndex - sourceIndex)
    ) {
      throw new VirtualGraphWorkspaceError(
        'diff-context-mismatch',
        `Unified diff hunk ${hunkIndex + 1} has a stale or overlapping line range for "${diff.path}".`,
        { path: diff.path },
      );
    }
    output.push(...source.slice(sourceIndex, expectedSourceIndex));
    sourceIndex = expectedSourceIndex;

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push({ text: line.text, hasNewline: !line.noNewline });
        continue;
      }
      const sourceLine = source[sourceIndex];
      if (!sourceLine || sourceLine.text !== line.text || sourceLine.hasNewline === line.noNewline) {
        throw new VirtualGraphWorkspaceError(
          'diff-context-mismatch',
          `Unified diff hunk ${hunkIndex + 1} does not exactly match "${diff.path}" at source line ${sourceIndex + 1}.`,
          { path: diff.path },
        );
      }
      if (line.kind === 'context') {
        output.push(sourceLine);
      }
      sourceIndex += 1;
    }
  }
  output.push(...source.slice(sourceIndex));
  return joinTextLines(output);
}

function emptyProjectDelta(): GraphBuilderProjectDraftDelta {
  return { graphDeltas: [] };
}

function projectDelta(before: AuthoringProject, after: AuthoringProject): GraphBuilderProjectDraftDelta {
  const beforeGraphIds = Object.keys(before.graphs).sort();
  const afterGraphIds = Object.keys(after.graphs).sort();
  if (JSON.stringify(beforeGraphIds) !== JSON.stringify(afterGraphIds)) {
    throw new VirtualGraphWorkspaceError(
      'invalid-project',
      'Virtual graph normalization may not add, remove, or rename project graphs.',
    );
  }
  const graphDeltas = beforeGraphIds.flatMap((rawGraphId) => {
    const graphId = rawGraphId as GraphId;
    const beforeGraph = before.graphs[graphId]!;
    const afterGraph = after.graphs[graphId]!;
    if (canonicalGraphBuilderAuthoringStringify(beforeGraph) === canonicalGraphBuilderAuthoringStringify(afterGraph)) {
      return [];
    }
    return [calculateGraphBuilderDraftDelta(before, after, graphId)];
  });
  if (graphDeltas.length > 32) {
    throw new VirtualGraphWorkspaceError(
      'invalid-project',
      'A virtual graph patch may not change more than 32 graphs.',
    );
  }
  return { graphDeltas };
}

function changedGraphIds(before: AuthoringProject, after: AuthoringProject): GraphId[] {
  return Object.keys(before.graphs)
    .filter(
      (rawGraphId) =>
        canonicalGraphBuilderAuthoringStringify(before.graphs[rawGraphId as GraphId]) !==
        canonicalGraphBuilderAuthoringStringify(after.graphs[rawGraphId as GraphId]),
    )
    .sort()
    .map((graphId) => graphId as GraphId);
}

function diagnostic(input: {
  code: string;
  message: string;
  graphId?: GraphId;
  expected?: unknown;
  actual?: unknown;
  repairHint?: string;
}): GraphDiagnostic {
  return {
    diagnosticKey: toBoundedGraphBuilderIdentifier(`virtual-workspace:${input.code}:${input.graphId ?? ''}`),
    ruleId: toBoundedGraphBuilderIdentifier(input.code),
    rulesVersion: VIRTUAL_WORKSPACE_RULES_VERSION,
    severity: 'error',
    verification: 'verified',
    message: input.message.slice(0, GRAPH_BUILDER_LIMITS.maxDiagnosticMessageLength),
    ...(input.graphId === undefined ? {} : { graphId: input.graphId }),
    ...(input.expected === undefined ? {} : { expected: input.expected as never }),
    ...(input.actual === undefined ? {} : { actual: input.actual as never }),
    ...(input.repairHint === undefined ? {} : { repairHint: input.repairHint }),
  };
}

function validatedResult(result: GraphBuilderDocumentPatchResult): GraphBuilderDocumentPatchResult {
  return parseGraphBuilderDocumentPatchResult(result);
}

export class VirtualGraphWorkspace {
  readonly #base: AuthoringProject;
  readonly #isSecretLikeKey: (key: string) => boolean;
  readonly #normalizeCandidate: NonNullable<VirtualGraphWorkspaceOptions['normalizeCandidate']>;
  readonly #validateCandidate: NonNullable<VirtualGraphWorkspaceOptions['validateCandidate']>;
  readonly #patchLedger = new Map<string, PatchLedgerEntry>();
  #documents = new Map<string, InternalVirtualGraphDocument>();
  #draft: AuthoringProject;
  #draftRevision: number;

  constructor(options: VirtualGraphWorkspaceOptions) {
    if (!Number.isSafeInteger(options.initialDraftRevision ?? 0) || (options.initialDraftRevision ?? 0) < 0) {
      throw new VirtualGraphWorkspaceError(
        'invalid-project',
        'Initial virtual graph draft revision must be a non-negative safe integer.',
      );
    }
    try {
      canonicalGraphBuilderAuthoringStringify(options.project);
    } catch (cause) {
      throw new VirtualGraphWorkspaceError(
        'invalid-project',
        'Virtual graph workspace project must be bounded, data-only authoring state.',
        { cause },
      );
    }
    this.#base = cloneDeep(options.project);
    this.#draft = cloneDeep(options.project);
    this.#draftRevision = options.initialDraftRevision ?? 0;
    this.#isSecretLikeKey = options.isSecretLikeKey ?? isGraphBuilderSecretFieldName;
    this.#normalizeCandidate = options.normalizeCandidate ?? ((input) => cloneDeep(input.candidate));
    this.#validateCandidate =
      options.validateCandidate ??
      (() => ({
        completeness: 'complete',
        diagnostics: [],
        blockingDiagnosticKeys: [],
      }));
    this.#documents = this.#buildDocuments(this.#draft);
  }

  getDraft(): AuthoringProject {
    return cloneDeep(this.#draft);
  }

  getDraftRevision(): number {
    return this.#draftRevision;
  }

  hasDraftChanges(): boolean {
    return canonicalGraphBuilderAuthoringStringify(this.#base) !== canonicalGraphBuilderAuthoringStringify(this.#draft);
  }

  getProjectDelta(): GraphBuilderProjectDraftDelta {
    return projectDelta(this.#base, this.#draft);
  }

  getProjectDraftDelta(): GraphBuilderProjectDraftDelta {
    return this.getProjectDelta();
  }

  getPolicyWorkspaceContext(activeGraphId: GraphId): VirtualGraphPolicyWorkspaceContext {
    const activeDocumentPath = getVirtualGraphDocumentPath(activeGraphId);
    const activeDocument = this.#documents.get(activeDocumentPath);
    if (!activeDocument) {
      throw new VirtualGraphWorkspaceError(
        'unknown-document',
        `Active graph "${activeGraphId}" has no virtual graph document.`,
        { path: activeDocumentPath },
      );
    }
    const activeWindow = boundedDocumentWindow(
      activeDocument.contents,
      activeDocument.lineOffsets,
      1,
      MAX_POLICY_ACTIVE_DOCUMENT_LINES,
      MAX_POLICY_ACTIVE_DOCUMENT_BYTES,
    );
    return {
      version: GRAPH_BUILDER_VIRTUAL_GRAPH_DOCUMENT_VERSION,
      activeDocumentPath,
      delta: this.getProjectDelta(),
      documents: [...this.#documents.values()]
        .sort((left, right) => compareGraphBuilderStrings(left.path, right.path))
        .map((document) => ({
          path: document.path,
          graphId: document.graphId,
          name: unicodePrefix(
            this.#draft.graphs[document.graphId]!.metadata?.name ?? document.graphId,
            GRAPH_BUILDER_LIMITS.maxDeltaNodeTitleLength,
          ),
          digest: document.digest,
          totalLength: document.contents.length,
          totalLines: document.lineOffsets.length,
          access: 'editable' as const,
        })),
      activeDocument: {
        path: activeDocument.path,
        digest: activeDocument.digest,
        startOffset: activeWindow.startOffset,
        endOffset: activeWindow.endOffset,
        totalLength: activeWindow.totalLength,
        ...(activeWindow.nextOffset === undefined ? {} : { nextOffset: activeWindow.nextOffset }),
        totalLines: activeWindow.totalLineCount,
        startLine: 1,
        endLine: activeWindow.endLine,
        content: activeWindow.contents,
        truncated: activeWindow.truncated,
      },
    };
  }

  readDocument(path: string, startLine = 1, lineCount?: number, startOffset?: number): VirtualGraphDocumentRead {
    const normalizedPath = normalizedVirtualDocumentPath(path);
    const document = this.#documents.get(normalizedPath);
    if (!document) {
      throw new VirtualGraphWorkspaceError('unknown-document', `Unknown virtual graph document "${normalizedPath}".`, {
        path: normalizedPath,
      });
    }
    if (
      !Number.isSafeInteger(startLine) ||
      startLine < 1 ||
      (startOffset !== undefined &&
        (!Number.isSafeInteger(startOffset) ||
          startOffset < 0 ||
          startOffset >= document.contents.length ||
          startLine !== 1 ||
          lineCount !== undefined ||
          (startOffset > 0 && /[\uDC00-\uDFFF]/u.test(document.contents[startOffset]!)))) ||
      (lineCount !== undefined &&
        (!Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > MAX_VIRTUAL_GRAPH_READ_LINES))
    ) {
      throw new VirtualGraphWorkspaceError(
        'invalid-read-window',
        `Virtual graph document reads require either a positive line window (up to ${MAX_VIRTUAL_GRAPH_READ_LINES} lines) or a non-negative continuation offset.`,
        { path: normalizedPath },
      );
    }

    const totalLineCount = document.lineOffsets.length;
    if (startLine > totalLineCount) {
      throw new VirtualGraphWorkspaceError(
        'invalid-read-window',
        `Virtual graph document "${normalizedPath}" has only ${totalLineCount} lines.`,
        { path: normalizedPath },
      );
    }
    const window = boundedDocumentWindow(
      document.contents,
      document.lineOffsets,
      startLine,
      lineCount ?? MAX_VIRTUAL_GRAPH_READ_LINES,
      MAX_VIRTUAL_GRAPH_READ_BYTES,
      startOffset,
    );
    return {
      contents: window.contents,
      digest: document.digest,
      draftRevision: this.#draftRevision,
      endOffset: window.endOffset,
      graphId: document.graphId,
      lineCount: window.lineCount,
      ...(window.nextOffset === undefined ? {} : { nextOffset: window.nextOffset }),
      path: document.path,
      startOffset: window.startOffset,
      startLine: startOffset === undefined ? startLine : window.endLine - window.lineCount + 1,
      totalLength: window.totalLength,
      totalLineCount: window.totalLineCount,
      truncated: window.truncated,
    };
  }

  applyUnifiedDiff(input: ApplyVirtualGraphUnifiedDiffInput): GraphBuilderDocumentPatchResult {
    return this.#applyResolvedDocumentEdit({
      patchId: input.patchId,
      expectedDraftRevision: input.expectedDraftRevision,
      patchIdentity: {
        type: 'unified-diff',
        expectedDraftRevision: input.expectedDraftRevision,
        unifiedDiff: input.unifiedDiff,
      },
      resolveEdit: () => {
        const parsedDiff = parseVirtualGraphUnifiedDiff(input.unifiedDiff);
        const document = this.#documents.get(parsedDiff.path);
        if (!document) {
          throw new VirtualGraphWorkspaceError(
            'unknown-document',
            `Unified diff targets unknown virtual graph document "${parsedDiff.path}".`,
            { path: parsedDiff.path },
          );
        }
        return {
          document,
          editedContents: applyParsedUnifiedDiff(document.contents, parsedDiff),
        };
      },
    });
  }

  applyDocumentPatch(input: ApplyVirtualGraphUnifiedDiffInput): GraphBuilderDocumentPatchResult {
    return this.applyUnifiedDiff(input);
  }

  replaceDocument(input: ReplaceVirtualGraphDocumentInput): GraphBuilderDocumentPatchResult {
    return this.#applyResolvedDocumentEdit({
      patchId: input.patchId,
      expectedDraftRevision: input.expectedDraftRevision,
      patchIdentity: {
        type: 'replace-document',
        contents: input.contents,
        expectedDraftRevision: input.expectedDraftRevision,
        path: input.path,
      },
      resolveEdit: () => {
        const path = normalizedVirtualDocumentPath(input.path);
        if (typeof input.contents !== 'string' || utf8ByteLength(input.contents) > MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES) {
          throw new VirtualGraphWorkspaceError(
            'invalid-graph-document',
            `Replacement content for "${path}" must be a string no larger than ${MAX_VIRTUAL_GRAPH_DOCUMENT_BYTES} bytes.`,
            { path },
          );
        }
        const document = this.#documents.get(path);
        if (!document) {
          throw new VirtualGraphWorkspaceError(
            'unknown-document',
            `Replacement targets unknown virtual graph document "${path}".`,
            { path },
          );
        }
        return { document, editedContents: input.contents };
      },
    });
  }

  #applyResolvedDocumentEdit(input: {
    expectedDraftRevision: number;
    patchId: string;
    patchIdentity: unknown;
    resolveEdit: () => ResolvedVirtualGraphDocumentEdit;
  }): GraphBuilderDocumentPatchResult {
    if (
      typeof input.patchId !== 'string' ||
      input.patchId.length === 0 ||
      input.patchId.length > GRAPH_BUILDER_LIMITS.maxIdentifierLength ||
      input.patchId.trim() !== input.patchId
    ) {
      throw new VirtualGraphWorkspaceError(
        'patch-identity-content-mismatch',
        'Virtual graph patch ID must be a bounded, non-empty, trimmed identifier.',
      );
    }
    const canonicalPatch = canonicalGraphBuilderAuthoringStringify(input.patchIdentity);
    const previous = this.#patchLedger.get(input.patchId);
    if (previous) {
      if (previous.canonicalPatch !== canonicalPatch) {
        throw new VirtualGraphWorkspaceError(
          'patch-identity-content-mismatch',
          `Virtual graph patch ID "${input.patchId}" was reused with different content.`,
        );
      }
      const original = cloneDeep(previous.result);
      return validatedResult({
        disposition: 'replayed',
        patchId: original.patchId,
        baseRevision: original.baseRevision,
        draftRevision: original.draftRevision,
        diagnostics: cloneDeep(original.diagnostics),
        original,
      });
    }

    let result: FreshGraphBuilderDocumentPatchResult;
    if (input.expectedDraftRevision !== this.#draftRevision) {
      result = {
        disposition: 'rejected',
        patchId: input.patchId,
        baseRevision: this.#draftRevision,
        draftRevision: this.#draftRevision,
        diagnostics: [
          diagnostic({
            code: 'expected-draft-revision',
            message: 'The document edit was proposed against a stale virtual graph draft revision.',
            expected: input.expectedDraftRevision,
            actual: this.#draftRevision,
            repairHint: 'Read the current virtual document revision and regenerate the edit against that exact text.',
          }),
        ],
      };
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    let document: InternalVirtualGraphDocument;
    let editedContents: string;
    try {
      ({ document, editedContents } = input.resolveEdit());
    } catch (cause) {
      result = this.#rejectedPatchResult(input.patchId, cause);
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    let normalizedCandidate: AuthoringProject;
    let attemptedDelta: GraphBuilderProjectDraftDelta | undefined;
    let normalizedChangedGraphIds: GraphId[];
    try {
      const editedGraph = parseVirtualGraphContents(
        editedContents,
        document.graphId,
        document.path,
        document.secretSlots,
        this.#isSecretLikeKey,
      );
      const candidate = cloneDeep(this.#draft);
      candidate.graphs[document.graphId] = editedGraph;
      normalizedCandidate = cloneDeep(
        this.#normalizeCandidate({
          base: cloneDeep(this.#base),
          candidate: cloneDeep(candidate),
          changedGraphIds: [document.graphId],
          current: cloneDeep(this.#draft),
        }),
      );
      canonicalGraphBuilderAuthoringStringify(normalizedCandidate);
      attemptedDelta = projectDelta(this.#draft, normalizedCandidate);
      normalizedChangedGraphIds = changedGraphIds(this.#draft, normalizedCandidate);
    } catch (cause) {
      result = this.#rejectedPatchResult(input.patchId, cause);
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    let validation: GraphValidationResult;
    try {
      validation = parseGraphValidationResult(
        this.#validateCandidate({
          base: cloneDeep(this.#base),
          candidate: cloneDeep(normalizedCandidate),
          changedGraphIds: normalizedChangedGraphIds,
          current: cloneDeep(this.#draft),
        }),
      );
    } catch (cause) {
      result = this.#rejectedPatchResult(
        input.patchId,
        new VirtualGraphWorkspaceError(
          'invalid-project',
          `Virtual graph candidate validation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause, path: document.path },
        ),
        attemptedDelta,
      );
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    if (validation.completeness !== 'complete' || validation.blockingDiagnosticKeys.length > 0) {
      const diagnostics = [...validation.diagnostics];
      if (validation.completeness !== 'complete') {
        diagnostics.push(
          diagnostic({
            code: 'candidate-validation-incomplete',
            graphId: document.graphId,
            message: 'Virtual graph candidate validation did not complete.',
            repairHint: 'Repair the graph or request the missing host context before applying another edit.',
          }),
        );
      }
      result = {
        disposition: 'rejected',
        patchId: input.patchId,
        baseRevision: this.#draftRevision,
        draftRevision: this.#draftRevision,
        diagnostics: diagnostics.slice(0, GRAPH_BUILDER_LIMITS.maxArrayItems),
        ...(attemptedDelta.graphDeltas.length > 0 ? { attemptedDelta } : {}),
      };
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    if (
      canonicalGraphBuilderAuthoringStringify(this.#draft) ===
      canonicalGraphBuilderAuthoringStringify(normalizedCandidate)
    ) {
      result = {
        disposition: 'no-op',
        patchId: input.patchId,
        baseRevision: this.#draftRevision,
        draftRevision: this.#draftRevision,
        delta: emptyProjectDelta(),
        diagnostics: validation.diagnostics,
      };
      this.#rememberPatch(input.patchId, canonicalPatch, result);
      return validatedResult(result);
    }

    const previousRevision = this.#draftRevision;
    const nextDocuments = this.#buildDocuments(normalizedCandidate);
    this.#draft = normalizedCandidate;
    this.#documents = nextDocuments;
    this.#draftRevision += 1;
    result = {
      disposition: 'applied',
      patchId: input.patchId,
      baseRevision: previousRevision,
      draftRevision: this.#draftRevision,
      delta: attemptedDelta,
      diagnostics: validation.diagnostics,
    };
    this.#rememberPatch(input.patchId, canonicalPatch, result);
    return validatedResult(result);
  }

  #buildDocuments(project: AuthoringProject): Map<string, InternalVirtualGraphDocument> {
    const documents = new Map<string, InternalVirtualGraphDocument>();
    for (const rawGraphId of Object.keys(project.graphs).sort()) {
      const graphId = rawGraphId as GraphId;
      const graph = project.graphs[graphId]!;
      if (graph.metadata?.id !== graphId) {
        throw new VirtualGraphWorkspaceError(
          'invalid-project',
          `Project graph "${graphId}" must retain the same metadata ID in the virtual workspace.`,
        );
      }
      const path = normalizedVirtualDocumentPath(getVirtualGraphDocumentPath(graphId));
      const serialized = canonicalVirtualGraphContents(graph, this.#isSecretLikeKey);
      documents.set(path, {
        contents: serialized.contents,
        digest: hashGraphBuilderString(serialized.contents),
        graphId,
        lineOffsets: buildLineOffsets(serialized.contents),
        path,
        secretSlots: serialized.secretSlots,
      });
    }
    return documents;
  }

  #documentDescriptors(): VirtualGraphDocumentDescriptor[] {
    return [...this.#documents.values()]
      .sort((left, right) => compareGraphBuilderStrings(left.path, right.path))
      .map((document) => ({
        digest: document.digest,
        draftRevision: this.#draftRevision,
        graphId: document.graphId,
        lineCount: document.lineOffsets.length,
        path: document.path,
      }));
  }

  #rejectedPatchResult(
    patchId: string,
    cause: unknown,
    attemptedDelta?: GraphBuilderProjectDraftDelta,
  ): FreshGraphBuilderDocumentPatchResult {
    const error =
      cause instanceof VirtualGraphWorkspaceError
        ? cause
        : new VirtualGraphWorkspaceError('invalid-project', cause instanceof Error ? cause.message : String(cause), {
            cause,
          });
    return {
      disposition: 'rejected',
      patchId,
      baseRevision: this.#draftRevision,
      draftRevision: this.#draftRevision,
      diagnostics: [
        diagnostic({
          code: error.code,
          message: error.message,
          repairHint:
            error.code === 'diff-context-mismatch'
              ? 'Read the exact current document lines and regenerate the hunk without fuzzy offsets.'
              : undefined,
        }),
      ],
      ...(attemptedDelta && attemptedDelta.graphDeltas.length > 0 ? { attemptedDelta } : {}),
    };
  }

  #rememberPatch(patchId: string, canonicalPatch: string, result: FreshGraphBuilderDocumentPatchResult): void {
    if (this.#patchLedger.size >= MAX_RETAINED_PATCH_IDENTITIES) {
      throw new VirtualGraphWorkspaceError(
        'invalid-project',
        'Virtual graph patch identity capacity has been exhausted for this bounded workspace.',
      );
    }
    this.#patchLedger.set(patchId, {
      canonicalPatch,
      result: cloneDeep(result),
    });
  }
}

export function createVirtualGraphWorkspace(options: VirtualGraphWorkspaceOptions): VirtualGraphWorkspace {
  return new VirtualGraphWorkspace(options);
}
