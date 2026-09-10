import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeProjectGlobalVariable,
  encodeProjectGlobalVariable,
  getDefaultValue,
  resolveProjectGlobalVariables,
  scalarTypes,
  validateProjectGlobalVariables,
  type GraphId,
  type Project,
  type ProjectId,
} from '../../src/index.js';

test('project global variables preserve portable binary, special numeric, and reserved-marker values', () => {
  const definition = encodeProjectGlobalVariable({
    type: 'object',
    value: {
      bytes: new Uint8Array([0, 1, 255]),
      finite: 2,
      infinity: Infinity,
      notANumber: Number.NaN,
      absent: undefined,
      marker: { $rivetProjectGlobalLiteral: 'ordinary user data' },
    },
  });

  const decoded = decodeProjectGlobalVariable(JSON.parse(JSON.stringify(definition)));
  assert.equal(decoded.type, 'object');
  const value = decoded.value as Record<string, unknown>;
  assert.deepEqual(value.bytes, new Uint8Array([0, 1, 255]));
  assert.equal(value.infinity, Infinity);
  assert.ok(Number.isNaN(value.notANumber));
  assert.equal(value.absent, undefined);
  assert.deepEqual(value.marker, { $rivetProjectGlobalLiteral: 'ordinary user data' });
});

test('project global variable codec accepts and round-trips every persistable built-in data type default', () => {
  for (const scalarType of scalarTypes) {
    if (scalarType === 'control-flow-excluded') continue;

    for (const type of [scalarType, `${scalarType}[]`] as const) {
      const definition = encodeProjectGlobalVariable({ type, value: getDefaultValue(type) } as never);
      const decoded = decodeProjectGlobalVariable(JSON.parse(JSON.stringify(definition)));
      assert.equal(decoded.type, type);
      assert.deepEqual(decoded.value, getDefaultValue(type));
    }
  }
});

test('project global variable validation rejects unsupported runtime values and malformed portable literals', () => {
  assert.throws(
    () => encodeProjectGlobalVariable({ type: 'any', value: () => undefined }),
    /cannot persist function values/,
  );
  assert.throws(
    () => validateProjectGlobalVariables({ broken: { type: 'fn<string>', value: 'nope' } }),
    /supported non-function data type/,
  );
  assert.throws(
    () => validateProjectGlobalVariables({ broken: { type: 'string', value: { $rivetProjectGlobalLiteral: 'bad' } } }),
    /invalid reserved literal marker/,
  );
  assert.throws(() => decodeProjectGlobalVariable({ type: 'number', value: 'not a number' }), /must be a number/);
  assert.throws(() => decodeProjectGlobalVariable({ type: 'number[]', value: 5 }), /must be an array/);
  assert.throws(
    () => encodeProjectGlobalVariable({ type: 'boolean', value: { truthy: true } } as never),
    /must be a boolean/,
  );
  assert.throws(
    () => validateProjectGlobalVariables({ ' ': { type: 'string', value: 'blank ID' } }),
    /empty variable ID/,
  );
  assert.throws(() => decodeProjectGlobalVariable({ type: 'number', value: Infinity }), /Rivet marker/);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => decodeProjectGlobalVariable({ type: 'object', value: circular }), /cannot be circular/);
  const sparse = new Array(1);
  assert.throws(() => decodeProjectGlobalVariable({ type: 'any[]', value: sparse }), /sparse array/);
});

function project(
  id: string,
  globalVariables: Project['metadata']['globalVariables'],
  references: Project['references'] = [],
): Project {
  const graphId = `${id}-graph` as GraphId;
  return {
    metadata: { id: id as ProjectId, title: id, description: '', mainGraphId: graphId, globalVariables },
    graphs: {
      [graphId]: {
        metadata: { id: graphId, name: id, description: '' },
        nodes: [],
        connections: [],
      },
    },
    plugins: [],
    references,
  };
}

test('project global variables merge depth-first in reference order and root project values win', () => {
  const grandchild = project('grandchild', {
    inherited: encodeProjectGlobalVariable({ type: 'string', value: 'grandchild' }),
  });
  const child = project(
    'child',
    {
      inherited: encodeProjectGlobalVariable({ type: 'string', value: 'child' }),
      childOnly: encodeProjectGlobalVariable({ type: 'number', value: 3 }),
    },
    [{ id: grandchild.metadata.id }],
  );
  const root = project(
    'root',
    {
      inherited: encodeProjectGlobalVariable({ type: 'string', value: 'root' }),
      rootOnly: encodeProjectGlobalVariable({ type: 'boolean', value: true }),
    },
    [{ id: child.metadata.id }],
  );

  const resolved = resolveProjectGlobalVariables(root, {
    [child.metadata.id]: child,
    [grandchild.metadata.id]: grandchild,
  });

  assert.deepEqual(
    [...resolved.entries()],
    [
      ['inherited', { type: 'string', value: 'root' }],
      ['childOnly', { type: 'number', value: 3 }],
      ['rootOnly', { type: 'boolean', value: true }],
    ],
  );
});

test('project global variable resolution keeps legacy reference cycles deterministic', () => {
  const root = project('root', { shared: encodeProjectGlobalVariable({ type: 'string', value: 'root' }) }, [
    { id: 'child' as ProjectId },
  ]);
  const child = project(
    'child',
    {
      shared: encodeProjectGlobalVariable({ type: 'string', value: 'child' }),
      childOnly: encodeProjectGlobalVariable({ type: 'number', value: 1 }),
    },
    [{ id: root.metadata.id }],
  );

  // The root is intentionally absent: GraphProcessor owns it in memory and
  // should never require the reference loader to fetch it again.
  const resolved = resolveProjectGlobalVariables(root, { [child.metadata.id]: child });

  assert.deepEqual(
    [...resolved.entries()],
    [
      ['shared', { type: 'string', value: 'root' }],
      ['childOnly', { type: 'number', value: 1 }],
    ],
  );
});
