import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertManagedSchemaMigrationSafe,
  assertManagedSchemaReadersCompatible,
  SCHEMA_READER_ANNOTATION,
} from '../managed-schema-cutover.js';
import type { Pool } from 'pg';
const release = 'fixture';
const resource = (version?: number, replicas = 1, component = 'backend') => ({
  metadata: {
    labels: { 'app.kubernetes.io/instance': release, 'app.kubernetes.io/component': component },
    annotations: version == null ? ({} as Record<string, string>) : { [SCHEMA_READER_ANNOTATION]: String(version) },
  },
  spec: {
    replicas,
    template: {
      metadata: {
        annotations: version == null ? ({} as Record<string, string>) : { [SCHEMA_READER_ANNOTATION]: String(version) },
      },
    },
  },
});

test('standalone migration distinguishes empty bootstrap, unversioned legacy and incompatible catalogs', async () => {
  const oldHost = process.env.KUBERNETES_SERVICE_HOST;
  const oldOffline = process.env.RIVET_MANAGED_SCHEMA_OFFLINE;
  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.RIVET_MANAGED_SCHEMA_OFFLINE;
  try {
    for (const state of [
      { version: 0, legacy: false },
      { version: 0, legacy: true },
      { version: 14, legacy: true },
      { version: 15, legacy: true },
    ]) {
      const pool = {
        query: async (sql: string, params?: unknown[]) => ({
          rows: [
            sql.includes('MAX(version)')
              ? { version: state.version }
              : { name: params ? (state.version ? 'ledger' : null) : state.legacy ? 'workflows' : null },
          ],
        }),
      } as unknown as Pool;
      if (state.legacy && state.version < 15)
        await assert.rejects(assertManagedSchemaMigrationSafe(pool), /all readers and writers stopped/);
      else await assertManagedSchemaMigrationSafe(pool);
      process.env.RIVET_MANAGED_SCHEMA_OFFLINE = '1';
      await assertManagedSchemaMigrationSafe(pool);
      delete process.env.RIVET_MANAGED_SCHEMA_OFFLINE;
    }
  } finally {
    if (oldHost == null) delete process.env.KUBERNETES_SERVICE_HOST;
    else process.env.KUBERNETES_SERVICE_HOST = oldHost;
    if (oldOffline == null) delete process.env.RIVET_MANAGED_SCHEMA_OFFLINE;
    else process.env.RIVET_MANAGED_SCHEMA_OFFLINE = oldOffline;
  }
});
const list = (...items: ReturnType<typeof resource>[]) => ({ items });
test('schema guard accepts bootstrap and compatible readers, not unknown or terminating old pods', () => {
  const empty = { pods: list(), deployments: list(), statefulsets: list(), autoscalers: list() };
  assert.doesNotThrow(() => assertManagedSchemaReadersCompatible(empty, release));
  assert.doesNotThrow(() => assertManagedSchemaReadersCompatible({ ...empty, pods: list(resource(15)) }, release));
  for (const version of [undefined, 14]) {
    assert.throws(
      () => assertManagedSchemaReadersCompatible({ ...empty, pods: list(resource(version)) }, release),
      /reader pod/,
    );
    assert.throws(
      () => assertManagedSchemaReadersCompatible({ ...empty, statefulsets: list(resource(version)) }, release),
      /controller/,
    );
    assert.doesNotThrow(() =>
      assertManagedSchemaReadersCompatible({ ...empty, statefulsets: list(resource(version, 0)) }, release),
    );
    assert.throws(
      () =>
        assertManagedSchemaReadersCompatible(
          { ...empty, statefulsets: list(resource(version, 0)), autoscalers: list(resource()) },
          release,
        ),
      /autoscaling/,
    );
  }
  assert.doesNotThrow(() =>
    assertManagedSchemaReadersCompatible(
      { ...empty, pods: list(resource(undefined, 1, 'workflow-schema-migration'), resource(undefined, 1, 'proxy')) },
      release,
    ),
  );
});
