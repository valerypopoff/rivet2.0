import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import {
  canonicalGraphBuilderAuthoringStringify,
  canonicalGraphBuilderStringify,
  compareGraphBuilderStrings,
  graphBuilderStringTupleKey,
  graphValidationResultSchema,
  hashCanonicalGraphBuilderValue,
  hashGraphBuilderString,
  parseApplyPatchResult,
  parseGraphBuilderDecision,
  parseGraphBuilderSessionResult,
  parseGraphValidationResult,
  parseGraphPatch,
  parsePortableJson,
  toBoundedGraphBuilderIdentifier,
} from './index.js';

test('portable JSON parsing creates a prototype-free clone and canonicalizes object keys', () => {
  const parsed = parsePortableJson({ z: [3, { b: true, a: null }], a: 'first' });

  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(canonicalGraphBuilderStringify(parsed), '{"a":"first","z":[3,{"a":null,"b":true}]}');
  assert.equal(hashCanonicalGraphBuilderValue({ b: 2, a: 1 }), hashCanonicalGraphBuilderValue({ a: 1, b: 2 }));
});

test('Graph Builder string ordering is locale-independent UTF-16 code-unit order', () => {
  assert.ok(compareGraphBuilderStrings('z', 'ä') < 0);
  assert.ok(compareGraphBuilderStrings('ä', 'z') > 0);
  assert.equal(compareGraphBuilderStrings('same', 'same'), 0);
});

test('Graph Builder tuple identities cannot collide through embedded delimiters', () => {
  assert.notEqual(graphBuilderStringTupleKey('a', 'b'), graphBuilderStringTupleKey('a\0b'));
  assert.notEqual(graphBuilderStringTupleKey('a\0b', 'c'), graphBuilderStringTupleKey('a', 'b\0c'));
});

test('bounded identifiers do not split a Unicode surrogate pair before the hash suffix', () => {
  const value = `${'a'.repeat(134)}😀${'b'.repeat(80)}`;
  const bounded = toBoundedGraphBuilderIdentifier(value);

  assert.ok(bounded.length <= 160);
  assert.doesNotMatch(bounded, /[\uD800-\uDFFF]/u);
  assert.match(bounded, /:fnv1a64:[0-9a-f]{16}$/);
});

test('string hashing preserves UTF-8 identities and distinguishes unpaired surrogates', () => {
  assert.equal(hashGraphBuilderString('abc'), 'fnv1a64:e71fa2190541574b');
  assert.notEqual(hashGraphBuilderString('\ud800'), hashGraphBuilderString('\ud801'));
  assert.notEqual(hashGraphBuilderString('\ud800'), hashGraphBuilderString('\ufffd'));
});

test('portable JSON parsing rejects dangerous keys, prototypes, cycles, and unsafe numbers', () => {
  const dangerous = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}');
  assert.throws(() => parsePortableJson(dangerous), /Dangerous object key/);
  assert.throws(() => parsePortableJson(new Date()), /Only plain objects/);
  assert.throws(() => parsePortableJson(Number.POSITIVE_INFINITY), /finite and within the safe numeric range/);
  assert.throws(() => parsePortableJson(Number.MAX_SAFE_INTEGER + 1), /finite and within the safe numeric range/);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => parsePortableJson(cyclic), /Cyclic values/);
});

test('portable JSON parsing rejects non-data surfaces without invoking accessors', () => {
  const sparse = new Array<unknown>(2);
  sparse[1] = 'present';
  assert.throws(() => parsePortableJson(sparse), /Sparse arrays/);

  const extraArrayProperty = ['present'] as unknown[] & { extra?: string };
  extraArrayProperty.extra = 'hidden from JSON serialization';
  assert.throws(() => parsePortableJson(extraArrayProperty), /hidden or extra/);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    },
  });
  assert.throws(() => parsePortableJson(accessor), /data properties/);
  assert.equal(getterCalls, 0);

  const hidden = { visible: true };
  Object.defineProperty(hidden, 'hidden', { value: true });
  assert.throws(() => parsePortableJson(hidden), /non-enumerable/);

  const symbol = { visible: true, [Symbol('hidden')]: true };
  assert.throws(() => parsePortableJson(symbol), /Symbol-keyed/);
});

test('portable size and canonical serialization cannot be replaced by toJSON hooks', () => {
  let inheritedToJsonCalls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() {
      inheritedToJsonCalls += 1;
      return { hijacked: true };
    },
  });
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() {
      inheritedToJsonCalls += 1;
      return ['hijacked'];
    },
  });
  try {
    assert.equal(canonicalGraphBuilderStringify({ z: [2, 1], a: true }), '{"a":true,"z":[2,1]}');
    assert.throws(() => parsePortableJson(['x'.repeat(100)], { maxBytes: 10 }), /10-byte limit/);
    assert.equal(inheritedToJsonCalls, 0);
  } finally {
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
    delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }

  let ownToJsonCalls = 0;
  const objectWithToJson = {
    safe: true,
    toJSON() {
      ownToJsonCalls += 1;
      return {};
    },
  };
  assert.throws(() => parsePortableJson(objectWithToJson), /Unsupported function value.*toJSON/);

  const arrayWithToJson = ['safe'];
  Object.defineProperty(arrayWithToJson, 'toJSON', {
    configurable: true,
    value() {
      ownToJsonCalls += 1;
      return [];
    },
  });
  assert.throws(() => parsePortableJson(arrayWithToJson), /hidden or extra properties/);

  const objectWithToJsonAccessor = { safe: true };
  Object.defineProperty(objectWithToJsonAccessor, 'toJSON', {
    configurable: true,
    enumerable: true,
    get() {
      ownToJsonCalls += 1;
      return () => ({});
    },
  });
  assert.throws(() => parsePortableJson(objectWithToJsonAccessor), /data properties/);
  assert.equal(ownToJsonCalls, 0);
});

test('authoring identity serialization is stable, omits optional object fields, and fails closed', () => {
  assert.equal(
    canonicalGraphBuilderAuthoringStringify({
      z: { present: true, omitted: undefined },
      a: [1, 2],
    }),
    '{"a":[1,2],"z":{"present":true}}',
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(cyclic), /authoring identity is cyclic/);

  const sparse = new Array<unknown>(2);
  sparse[1] = 'present';
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(sparse), /sparse array data/);
  assert.throws(() => canonicalGraphBuilderAuthoringStringify([undefined]), /undefined array data/);
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(new Date()), /non-plain object/);

  const hidden = { visible: true };
  Object.defineProperty(hidden, 'hidden', { value: true });
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(hidden), /non-enumerable data/);

  let getterCalls = 0;
  const accessorArray = ['safe'];
  Object.defineProperty(accessorArray, 0, {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'must-not-run';
    },
  });
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(accessorArray), /non-data array entry/);
  assert.equal(getterCalls, 0);

  const extraArrayProperty = ['safe'] as string[] & { extra?: string };
  extraArrayProperty.extra = 'ignored by JSON';
  assert.throws(() => canonicalGraphBuilderAuthoringStringify(extraArrayProperty), /extra array data/);
});

test('authoring canonicalization cannot be replaced by inherited toJSON hooks', () => {
  let toJsonCalls = 0;
  Object.defineProperty(Object.prototype, 'toJSON', {
    configurable: true,
    value() {
      toJsonCalls += 1;
      return { hijacked: true };
    },
  });
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value() {
      toJsonCalls += 1;
      return ['hijacked'];
    },
  });
  try {
    assert.equal(canonicalGraphBuilderAuthoringStringify({ z: [2, 1], a: true }), '{"a":true,"z":[2,1]}');
    assert.equal(toJsonCalls, 0);
  } finally {
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
    delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
});

test('strict Graph Builder schemas reject unknown fields and duplicate patch client IDs', () => {
  assert.throws(
    () =>
      parseGraphPatch({
        protocolVersion: 1,
        patchId: 'patch-1',
        expectedDraftRevision: 0,
        operations: [
          { op: 'createNode', clientId: 'same', authoringChoiceId: 'registered:text' },
          { op: 'createNode', clientId: 'same', authoringChoiceId: 'registered:text' },
        ],
      }),
    z.ZodError,
  );

  assert.throws(
    () =>
      parseGraphPatch({
        protocolVersion: 1,
        patchId: 'patch-1',
        expectedDraftRevision: 0,
        unexpected: true,
        operations: [{ op: 'createNode', clientId: 'node', authoringChoiceId: 'registered:text' }],
      }),
    z.ZodError,
  );

  assert.throws(
    () =>
      parseGraphPatch({
        protocolVersion: 1,
        patchId: 'patch-1',
        expectedDraftRevision: 0,
        operations: [{ op: 'createNode', clientId: 'constructor', authoringChoiceId: 'registered:text' }],
      }),
    z.ZodError,
  );
});

test('request-context decisions reject duplicate canonical read requests', () => {
  assert.throws(
    () =>
      parseGraphBuilderDecision({
        type: 'request-context',
        requests: [
          { type: 'search-node-types', queries: ['text'], limit: 5 },
          { limit: 5, queries: ['text'], type: 'search-node-types' },
        ],
      }),
    z.ZodError,
  );
});

test('read requests reject duplicate values inside semantically set-like arrays', () => {
  const requests = [
    { type: 'search-node-types', queries: ['text', 'text'], limit: 5 },
    { type: 'get-node-specs', authoringChoiceIds: ['registered:text', 'registered:text'] },
    { type: 'inspect-draft', nodeIds: ['node', 'node'], fields: ['identity'] },
    { type: 'inspect-draft', nodeIds: ['node'], fields: ['identity', 'identity'] },
    { type: 'list-project-resources', kinds: ['graph', 'graph'], limit: 5 },
  ];

  for (const request of requests) {
    assert.throws(() => parseGraphBuilderDecision({ type: 'request-context', requests: [request] }), z.ZodError);
  }
});

test('validation results require every blocking key to identify a returned diagnostic', () => {
  assert.throws(
    () =>
      graphValidationResultSchema.parse({
        completeness: 'complete',
        diagnostics: [],
        blockingDiagnosticKeys: ['missing'],
      }),
    z.ZodError,
  );
});

test('validation identities stay bounded and duplicate diagnostic keys fail closed', () => {
  const sharedPrefix = 'diagnostic:'.repeat(20);
  const first = toBoundedGraphBuilderIdentifier(`${sharedPrefix}first`);
  const second = toBoundedGraphBuilderIdentifier(`${sharedPrefix}second`);
  assert.ok(first.length <= 160);
  assert.ok(second.length <= 160);
  assert.notEqual(first, second);

  const duplicate = {
    diagnosticKey: 'duplicate',
    ruleId: 'test-rule',
    rulesVersion: 'test-v1',
    severity: 'error' as const,
    verification: 'verified' as const,
    message: 'Duplicate',
  };
  assert.throws(
    () =>
      parseGraphValidationResult({
        completeness: 'complete',
        diagnostics: [duplicate, duplicate],
        blockingDiagnosticKeys: ['duplicate', 'duplicate'],
      }),
    z.ZodError,
  );
});

test('replayed patch results must retain the original patch and proposal identities', () => {
  const original = {
    disposition: 'no-op' as const,
    patchId: 'patch-1',
    proposalHash: 'proposal-1',
    draftRevision: 0,
    delta: {
      graphId: 'graph',
      addedNodes: [],
      removedNodes: [],
      updatedNodes: [],
      addedConnections: [],
      removedConnections: [],
    },
    diagnostics: [],
  };

  assert.equal(
    parseApplyPatchResult({
      disposition: 'replayed',
      patchId: 'patch-1',
      proposalHash: 'proposal-1',
      original,
    }).disposition,
    'replayed',
  );
  assert.throws(
    () =>
      parseApplyPatchResult({
        disposition: 'replayed',
        patchId: 'different-patch',
        proposalHash: 'proposal-1',
        original,
      }),
    z.ZodError,
  );
  assert.throws(
    () =>
      parseApplyPatchResult({
        disposition: 'replayed',
        patchId: 'patch-1',
        proposalHash: 'different-proposal',
        original,
      }),
    z.ZodError,
  );
});

test('session results are versioned, bounded, and strict', () => {
  const result = parseGraphBuilderSessionResult({
    status: 'committed',
    base: {
      projectId: 'project',
      activeGraphId: 'graph',
      editorRevision: 3,
      projectFingerprint: 'project-fingerprint',
      registryContractFingerprint: 'registry-fingerprint',
      referencedProjectsFingerprint: 'references-fingerprint',
      policyConfigFingerprint: 'policy-fingerprint',
      validationRulesVersion: 'rules-v1',
      protocolVersion: 1,
    },
    draftRevision: 2,
    summary: 'Created and connected two nodes.',
  });

  assert.equal(result.status, 'committed');
  assert.throws(
    () =>
      parseGraphBuilderSessionResult({
        status: 'canceled',
        extra: true,
      }),
    z.ZodError,
  );
});
