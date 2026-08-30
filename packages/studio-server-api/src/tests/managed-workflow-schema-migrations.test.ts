import assert from 'node:assert/strict';
import test from 'node:test';

import type { Pool } from 'pg';

import {
  CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION,
  getManagedWorkflowSchemaCompatibilityWindow,
  getManagedWorkflowSchemaMode,
  MANAGED_WORKFLOW_SCHEMA_MIGRATIONS,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES,
  MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES,
  migrateManagedWorkflowSchema,
  verifyManagedWorkflowSchema,
} from '../routes/workflows/managed/schema-migrations.js';

type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

type DatabaseSnapshot = {
  migrationTableExists: boolean;
  schemaReady: boolean;
  migrations: Map<number, AppliedMigration>;
};

type FakeSchemaDatabase = DatabaseSnapshot & {
  applyCount: number;
  destroyedReleaseCount: number;
  failNextMigration: boolean;
  failRollback: boolean;
  invalidColumnShape: string | null;
  invalidColumnDefault: string | null;
  invalidConstraint: string | null;
  invalidConstraintIndex: string | null;
  invalidConstraintValidation: string | null;
  invalidFunctionBody: boolean;
  invalidFunctionExecute: boolean;
  invalidTablePermissions: string | null;
  invalidTableSecurity: string | null;
  invalidIndexDefinition: string | null;
  invalidIndexOptions: string | null;
  invalidIndexState: string | null;
  invalidIndexTable: string | null;
  missingObject: string | null;
  queryLog: string[];
  lockTail: Promise<void>;
  transientLockFailures: number;
};

function createDatabase(overrides: Partial<FakeSchemaDatabase> = {}): FakeSchemaDatabase {
  return {
    migrationTableExists: false,
    schemaReady: false,
    migrations: new Map(),
    applyCount: 0,
    destroyedReleaseCount: 0,
    failNextMigration: false,
    failRollback: false,
    invalidColumnShape: null,
    invalidColumnDefault: null,
    invalidConstraint: null,
    invalidConstraintIndex: null,
    invalidConstraintValidation: null,
    invalidFunctionBody: false,
    invalidFunctionExecute: false,
    invalidTablePermissions: null,
    invalidTableSecurity: null,
    invalidIndexDefinition: null,
    invalidIndexOptions: null,
    invalidIndexState: null,
    invalidIndexTable: null,
    missingObject: null,
    queryLog: [],
    lockTail: Promise.resolve(),
    transientLockFailures: 0,
    ...overrides,
  };
}

function currentMigration(): AppliedMigration {
  const migration = MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.at(-1);
  assert.ok(migration);
  return {
    version: migration.version,
    name: migration.name,
    checksum: migration.checksum,
  };
}

function createCurrentDatabase(): FakeSchemaDatabase {
  return createDatabase({
    migrationTableExists: true,
    schemaReady: true,
    migrations: new Map(
      MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.map((migration) => [
        migration.version,
        {
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
        },
      ]),
    ),
  });
}

function queryResult(rows: unknown[] = []) {
  return { rows, rowCount: rows.length };
}

function cloneSnapshot(database: FakeSchemaDatabase): DatabaseSnapshot {
  return {
    migrationTableExists: database.migrationTableExists,
    schemaReady: database.schemaReady,
    migrations: new Map(database.migrations),
  };
}

function restoreSnapshot(database: FakeSchemaDatabase, snapshot: DatabaseSnapshot): void {
  database.migrationTableExists = snapshot.migrationTableExists;
  database.schemaReady = snapshot.schemaReady;
  database.migrations = new Map(snapshot.migrations);
}

function createPool(database: FakeSchemaDatabase): Pick<Pool, 'connect'> {
  return {
    connect: async () => {
      let releaseLock: (() => void) | null = null;
      let transactionSnapshot: DatabaseSnapshot | null = null;

      const finishTransaction = (restore: boolean): void => {
        if (restore && transactionSnapshot) {
          restoreSnapshot(database, transactionSnapshot);
        }
        transactionSnapshot = null;
        releaseLock?.();
        releaseLock = null;
      };

      return {
        query: async (rawSql: string, params: unknown[] = []) => {
          const sql = rawSql.trim();
          database.queryLog.push(sql);

          if (sql === 'BEGIN' || sql.startsWith('SET LOCAL')) {
            return queryResult();
          }

          if (sql.includes('pg_advisory_xact_lock')) {
            if (database.transientLockFailures > 0) {
              database.transientLockFailures -= 1;
              throw Object.assign(new Error('simulated lock timeout'), { code: '55P03' });
            }
            const previousLock = database.lockTail;
            database.lockTail = new Promise<void>((resolve) => {
              releaseLock = resolve;
            });
            await previousLock;
            transactionSnapshot = cloneSnapshot(database);
            return queryResult();
          }

          if (sql === 'COMMIT') {
            finishTransaction(false);
            return queryResult();
          }

          if (sql === 'ROLLBACK') {
            if (database.failRollback) {
              database.failRollback = false;
              throw new Error('simulated rollback failure');
            }
            finishTransaction(true);
            return queryResult();
          }

          if (sql.startsWith('CREATE TABLE IF NOT EXISTS managed_workflow_schema_migrations')) {
            database.migrationTableExists = true;
            return queryResult();
          }

          if (sql.includes('FROM information_schema.tables') && sql.includes('table_name = $1::text')) {
            assert.match(sql, /table_type = 'BASE TABLE'/);
            return queryResult([
              { object_name: database.migrationTableExists ? 'managed_workflow_schema_migrations' : null },
            ]);
          }

          if (sql.startsWith('SELECT version, name, checksum')) {
            return queryResult([...database.migrations.values()].sort((left, right) => left.version - right.version));
          }

          if (MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.some((migration) => migration.sql.trim() === sql)) {
            database.applyCount += 1;
            if (database.failNextMigration) {
              database.failNextMigration = false;
              throw new Error('simulated migration failure');
            }
            database.schemaReady = true;
            return queryResult();
          }

          if (sql.startsWith('INSERT INTO managed_workflow_schema_migrations')) {
            const [version, name, checksum] = params as [number, string, string];
            database.migrations.set(version, { version, name, checksum });
            return queryResult();
          }

          if (sql.includes('FROM pg_class table_relation')) {
            const requested = params[0] as string[];
            return queryResult(
              database.schemaReady
                ? requested
                    .filter((name) => database.missingObject !== `table:${name}`)
                    .map((name) => ({
                      name,
                      row_security: database.invalidTableSecurity === name,
                      forced_row_security: false,
                      can_select: database.invalidTablePermissions !== name,
                      can_insert: true,
                      can_update: true,
                      can_delete: true,
                    }))
                : [],
            );
          }

          if (sql.includes('FROM information_schema.columns')) {
            const requestedTables = new Set(params[0] as string[]);
            const expectedDefaults = new Map(
              MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS.map(([tableName, columnName, defaultValue]) => [
                `${tableName}.${columnName}`,
                defaultValue,
              ]),
            );
            return queryResult(
              database.schemaReady
                ? MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.filter(
                    ([tableName, columnName]) =>
                      requestedTables.has(tableName) && database.missingObject !== `column:${tableName}.${columnName}`,
                  ).map(([table_name, column_name, udt_name, is_nullable]) => {
                    const qualifiedName = `${table_name}.${column_name}`;
                    return {
                      table_name,
                      column_name,
                      udt_name: database.invalidColumnShape === qualifiedName ? 'bytea' : udt_name,
                      is_nullable,
                      column_default:
                        database.invalidColumnDefault === qualifiedName
                          ? null
                          : expectedDefaults.get(qualifiedName) ?? null,
                    };
                  })
                : [],
            );
          }

          if (sql.includes('FROM pg_index')) {
            const requested = params[0] as string[];
            const expectedIndexes = new Map<
              string,
              {
                tableName: string;
                keyExpressions: readonly string[];
                keyOptions: readonly number[];
                predicate: string | null;
              }
            >(
              MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.map(
                ([tableName, indexName, keyExpressions, predicate, keyOptions]) => [
                  indexName,
                  { tableName, keyExpressions, keyOptions, predicate },
                ],
              ),
            );
            return queryResult(
              database.schemaReady
                ? requested
                    .filter((name) => database.missingObject !== `index:${name}`)
                    .map((name) => {
                      const expected = expectedIndexes.get(name);
                      return {
                        name,
                        table_name: database.invalidIndexTable === name ? 'wrong_table' : expected?.tableName,
                        method: 'btree',
                        is_unique: false,
                        is_valid: database.invalidIndexState !== name,
                        is_ready: database.invalidIndexState !== name,
                        key_expressions:
                          database.invalidIndexDefinition === name ? ['wrong_column'] : expected?.keyExpressions,
                        key_options:
                          database.invalidIndexOptions === name
                            ? expected?.keyOptions.map(() => 0)
                            : expected?.keyOptions,
                        predicate: expected?.predicate,
                      };
                    })
                : [],
            );
          }

          if (sql.includes('FROM pg_constraint')) {
            const requestedTables = new Set(params[0] as string[]);
            return queryResult(
              database.schemaReady
                ? MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.filter(
                    ([tableName, type, definition]) =>
                      requestedTables.has(tableName) &&
                      database.missingObject !== `constraint:${tableName}/${type}/${definition}`,
                  ).map(([table_name, type, definition]) => ({
                    table_name,
                    type,
                    definition:
                      database.invalidConstraint === `${table_name}/${type}/${definition}`
                        ? 'PRIMARY KEY (wrong_column)'
                        : definition,
                    is_validated: database.invalidConstraintValidation !== `${table_name}/${type}/${definition}`,
                    backing_index_valid: database.invalidConstraintIndex !== `${table_name}/${type}/${definition}`,
                    backing_index_ready: database.invalidConstraintIndex !== `${table_name}/${type}/${definition}`,
                  }))
                : [],
            );
          }

          if (sql.includes('FROM pg_proc')) {
            assert.match(sql, /current_schema\(\).*\$1::text/);
            assert.deepEqual(params, [
              MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.name,
              MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.argumentTypes,
            ]);
            return queryResult(
              database.schemaReady && database.missingObject !== 'function'
                ? [
                    {
                      source_checksum: database.invalidFunctionBody
                        ? '0'.repeat(32)
                        : MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.sourceChecksum,
                      language: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.language,
                      volatility: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.volatility,
                      security_definer: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.securityDefiner,
                      can_execute: database.invalidFunctionExecute
                        ? false
                        : MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.canExecute,
                      result_type: MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.resultType,
                    },
                  ]
                : [],
            );
          }

          throw new Error(`Unexpected fake database query: ${sql.slice(0, 120)}`);
        },
        release: (discard?: boolean) => {
          if (discard) {
            database.destroyedReleaseCount += 1;
            finishTransaction(true);
          } else {
            releaseLock?.();
            releaseLock = null;
          }
        },
      } as never;
    },
  } as Pick<Pool, 'connect'>;
}

const quietLogger = {
  log() {},
  warn() {},
};

test('managed schema mode defaults to migrate and accepts only migrate or verify', () => {
  assert.equal(getManagedWorkflowSchemaMode({}), 'migrate');
  assert.equal(getManagedWorkflowSchemaMode({ RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: ' migrate ' }), 'migrate');
  assert.equal(getManagedWorkflowSchemaMode({ RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'VERIFY' }), 'verify');
  assert.throws(
    () => getManagedWorkflowSchemaMode({ RIVET_MANAGED_WORKFLOW_SCHEMA_MODE: 'off' }),
    /Expected "migrate" or "verify"/,
  );
});

test('managed schema compatibility windows are explicit and reject invalid bounds', () => {
  assert.deepEqual(getManagedWorkflowSchemaCompatibilityWindow({}), {
    minimumVersion: 10,
    maximumVersion: 10,
  });
  assert.deepEqual(
    getManagedWorkflowSchemaCompatibilityWindow({
      RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION: '2',
      RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION: '9',
    }),
    { minimumVersion: 2, maximumVersion: 9 },
  );
  assert.throws(
    () => getManagedWorkflowSchemaCompatibilityWindow({ RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION: 'zero' }),
    /Expected a positive integer schema version/,
  );
  assert.throws(
    () =>
      getManagedWorkflowSchemaCompatibilityWindow({
        RIVET_MANAGED_WORKFLOW_SCHEMA_MIN_VERSION: '3',
        RIVET_MANAGED_WORKFLOW_SCHEMA_MAX_VERSION: '2',
      }),
    /minimum version cannot exceed maximum version/,
  );
});

test('managed schema migration definitions and compatibility probes remain coherent', () => {
  assert.equal(CURRENT_MANAGED_WORKFLOW_SCHEMA_VERSION, 10);
  assert.deepEqual(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS.map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[0]?.checksum,
    '692f720796964d6ae4f25bcbfc7b1f11616fcc1012e7bcf506dec9428c9ce3b6',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[1]?.checksum,
    '4b531b5c4404eef0ddef0b08ed3a85f31f88a203151a5452986565536a04fe80',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[2]?.checksum,
    'bd4cc69a896623c0e6fb56ab47ea087d1791137348afaabc3c31399ccf56bd3e',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[3]?.checksum,
    '6c6965c2d883e38d452345ab7730cb5704bc773275db41d9e7f3de00622cd330',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[4]?.checksum,
    '77cc68364a05ba7afadaa0634ea1945353d120dd3d338cd5c9ef09111f756bbf',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[5]?.checksum,
    '29e225e645272fced8e1c8e8be268a8667a7f069bb3fba3ee1213759815d1e05',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[6]?.checksum,
    'f59063f1e999390b488d409eebe3c8c36880943b2848e655fb81b39fb027b4a9',
  );
  assert.ok(MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES.length > 10);
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[7]?.checksum,
    '5e58ca90c2f9f0233e5933ea7055614b61ce804cb67f8c1729fbe7d18084e207',
  );
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[8]?.checksum,
    '23643af7d68c3dfa75d061c2b0348b97ec06ebcbc3d7032afecf81cf10cf364f',
  );
  assert.equal(MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.length, 205);
  assert.equal(
    MANAGED_WORKFLOW_SCHEMA_MIGRATIONS[9]?.checksum,
    'bf0c0eadd2b170a6c8796ca28dfcc4afa7034b54a22198ef25a9e086884288ce',
  );
  const requiredColumnKeys = MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.map(
    ([tableName, columnName]) => `${tableName}.${columnName}`,
  );
  assert.equal(new Set(requiredColumnKeys).size, requiredColumnKeys.length);
  assert.equal(MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS.length, 57);
  const requiredDefaultKeys = MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS.map(
    ([tableName, columnName]) => `${tableName}.${columnName}`,
  );
  assert.equal(new Set(requiredDefaultKeys).size, requiredDefaultKeys.length);
  assert.ok(requiredDefaultKeys.every((key) => requiredColumnKeys.includes(key)));
  assert.deepEqual(
    new Set(MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS.map(([tableName]) => tableName)),
    new Set([...MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES, 'managed_workflow_schema_migrations']),
  );
  assert.equal(MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.length, 30);
  const requiredIndexNames = MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.map(([, indexName]) => indexName);
  assert.equal(new Set(requiredIndexNames).size, requiredIndexNames.length);
  assert.ok(MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.every(([, , keyExpressions]) => keyExpressions.length > 0));
  assert.ok(
    MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES.every(
      ([, , keyExpressions, , keyOptions]) => keyOptions.length === keyExpressions.length,
    ),
  );
  assert.equal(MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.length, 74);
  const requiredConstraintSignatures = MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.map((constraint) =>
    JSON.stringify(constraint),
  );
  assert.equal(new Set(requiredConstraintSignatures).size, requiredConstraintSignatures.length);
  assert.match(MANAGED_WORKFLOW_SCHEMA_REQUIRED_FUNCTION.sourceChecksum, /^[a-f0-9]{32}$/);
});

test('concurrent schema migrators serialize and apply each migration once', async () => {
  const database = createDatabase();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => migrateManagedWorkflowSchema(createPool(database), { logger: quietLogger })),
  );

  assert.equal(database.applyCount, 10);
  assert.deepEqual([...database.migrations.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(results.every(({ currentVersion }) => currentVersion === 10));
  assert.equal(results.filter(({ appliedVersions }) => appliedVersions.length === 0).length, 3);
  assert.equal(results.filter(({ appliedVersions }) => appliedVersions.join(',') === '1,2,3,4,5,6,7,8,9,10').length, 1);
  assert.equal(database.queryLog.filter((sql) => sql.includes('pg_advisory_xact_lock(')).length, 4);
});

test('migration baselines an existing unversioned schema without losing compatibility', async () => {
  const database = createDatabase({ schemaReady: true });
  const result = await migrateManagedWorkflowSchema(createPool(database), { logger: quietLogger });

  assert.deepEqual(result, { currentVersion: 10, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.equal(database.migrationTableExists, true);
  assert.equal(database.schemaReady, true);
  assert.equal(database.migrations.get(10)?.checksum, currentMigration().checksum);
});

test('verify mode takes a shared lock and never applies schema SQL', async () => {
  const database = createCurrentDatabase();
  const result = await verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger });

  assert.deepEqual(result, { currentVersion: 10, appliedVersions: [] });
  assert.equal(database.applyCount, 0);
  assert.ok(database.queryLog.some((sql) => sql.includes('pg_advisory_xact_lock_shared')));
  assert.ok(
    !database.queryLog.some((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS managed_workflow_schema_migrations')),
  );
});

test('verify mode rejects a database that has not been migrated', async () => {
  const database = createDatabase({ schemaReady: true });

  await assert.rejects(
    verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
    /schema metadata is missing.*workflow-schema:migrate/i,
  );
  assert.equal(database.migrationTableExists, false);
  assert.ok(database.queryLog.includes('ROLLBACK'));
});

test('schema compatibility rejects future and modified migration histories', async (t) => {
  await t.test('future version', async () => {
    const database = createCurrentDatabase();
    database.migrations.set(11, { version: 11, name: 'future', checksum: 'f'.repeat(64) });
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /newer than this server supports/,
    );
  });

  await t.test('checksum mismatch', async () => {
    const database = createCurrentDatabase();
    database.migrations.set(1, {
      ...currentMigration(),
      checksum: '0'.repeat(64),
    });
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /does not match this build/,
    );
  });
});

test('verify mode accepts only an explicitly declared additive successor schema', async () => {
  const database = createCurrentDatabase();
  database.migrations.set(11, { version: 11, name: 'successor', checksum: 'f'.repeat(64) });

  await assert.rejects(
    verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
    /newer than this server supports/,
  );

  const result = await verifyManagedWorkflowSchema(createPool(database), {
    logger: quietLogger,
    compatibilityWindow: { minimumVersion: 10, maximumVersion: 11 },
  });
  assert.deepEqual(result, { currentVersion: 11, appliedVersions: [] });
  assert.equal(database.applyCount, 0);
});

test('schema compatibility rejects a ledger marked current when required objects are missing', async (t) => {
  for (const [label, missingObject, expected] of [
    ['table', `table:${MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES[0]}`, /tables:/],
    ['column', `column:${MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS[0]?.slice(0, 2).join('.')}`, /columns:/],
    ['index', `index:${MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES[0]?.[1]}`, /indexes:/],
    ['constraint', `constraint:${MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS[0]?.join('/')}`, /constraints:/],
    ['function', 'function', /function:/],
  ] as const) {
    await t.test(label, async () => {
      const database = createCurrentDatabase();
      database.missingObject = missingObject;
      await assert.rejects(verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }), expected);
    });
  }

  await t.test('column shape', async () => {
    const database = createCurrentDatabase();
    const [tableName, columnName, expectedUdtName, expectedNullable] =
      MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMNS[0] ?? [];
    database.invalidColumnShape = `${tableName}.${columnName}`;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      new RegExp(`expected ${expectedUdtName}/${expectedNullable}, received bytea/${expectedNullable}`),
    );
  });

  await t.test('column default', async () => {
    const database = createCurrentDatabase();
    const [tableName, columnName, expectedDefault] = MANAGED_WORKFLOW_SCHEMA_REQUIRED_COLUMN_DEFAULTS[0] ?? [];
    database.invalidColumnDefault = `${tableName}.${columnName}`;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      new RegExp(`column defaults:.*expected ${expectedDefault?.replace(/[()]/g, '\\$&')}, received missing`),
    );
  });

  await t.test('table row-level security', async () => {
    const database = createCurrentDatabase();
    database.invalidTableSecurity = MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES[0] ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /tables:.*row-level security is enabled/,
    );
  });

  await t.test('table privileges', async () => {
    const database = createCurrentDatabase();
    database.invalidTablePermissions = MANAGED_WORKFLOW_SCHEMA_REQUIRED_TABLES[0] ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /tables:.*current role lacks SELECT/,
    );
  });

  await t.test('index table', async () => {
    const database = createCurrentDatabase();
    database.invalidIndexTable = MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES[0]?.[1] ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /"tableName":"[^"]+".*"tableName":"wrong_table"/,
    );
  });

  await t.test('index definition', async () => {
    const database = createCurrentDatabase();
    database.invalidIndexDefinition = MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES[0]?.[1] ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /"keyExpressions":\[[^\]]+\].*"keyExpressions":\["wrong_column"\]/,
    );
  });

  await t.test('index sort order', async () => {
    const database = createCurrentDatabase();
    database.invalidIndexOptions = 'workflow_recordings_created_at_idx';
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /"keyOptions":\[3\].*"keyOptions":\[0\]/,
    );
  });

  await t.test('invalid index state', async () => {
    const database = createCurrentDatabase();
    database.invalidIndexState = MANAGED_WORKFLOW_SCHEMA_REQUIRED_INDEXES[0]?.[1] ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /"isValid":true.*"isValid":false/,
    );
  });

  await t.test('constraint definition', async () => {
    const database = createCurrentDatabase();
    database.invalidConstraint =
      MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.find(
        ([tableName, type]) => tableName === 'evaluation_dataset_snapshots' && type === 'p',
      )?.join('/') ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /constraints:.*PRIMARY KEY \(project_id, dataset_fingerprint\)/,
    );
  });

  await t.test('unvalidated constraint', async () => {
    const database = createCurrentDatabase();
    database.invalidConstraintValidation = MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS[0]?.join('/') ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /constraints:.*not validated/,
    );
  });

  await t.test('invalid constraint backing index', async () => {
    const database = createCurrentDatabase();
    database.invalidConstraintIndex =
      MANAGED_WORKFLOW_SCHEMA_REQUIRED_CONSTRAINTS.find(([, type]) => type === 'p')?.join('/') ?? null;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /constraints:.*backing index is invalid or unready/,
    );
  });

  await t.test('function body', async () => {
    const database = createCurrentDatabase();
    database.invalidFunctionBody = true;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /function:.*sourceChecksum.*00000000000000000000000000000000/,
    );
  });

  await t.test('function execute privilege', async () => {
    const database = createCurrentDatabase();
    database.invalidFunctionExecute = true;
    await assert.rejects(
      verifyManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
      /function:.*"canExecute":true.*"canExecute":false/,
    );
  });
});

test('failed migration rolls back its ledger and can be retried cleanly', async () => {
  const database = createDatabase({ failNextMigration: true });

  await assert.rejects(
    migrateManagedWorkflowSchema(createPool(database), { logger: quietLogger }),
    /simulated migration failure/,
  );
  assert.equal(database.migrationTableExists, false);
  assert.equal(database.schemaReady, false);
  assert.equal(database.migrations.size, 0);

  const result = await migrateManagedWorkflowSchema(createPool(database), { logger: quietLogger });
  assert.deepEqual(result, { currentVersion: 10, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.equal(database.applyCount, 11);
});

test('failed rollback preserves the migration error and destroys the uncertain client', async () => {
  const database = createDatabase({ failNextMigration: true, failRollback: true });
  const warnings: unknown[][] = [];

  await assert.rejects(
    migrateManagedWorkflowSchema(createPool(database), {
      logger: {
        log() {},
        warn(...args) {
          warnings.push(args);
        },
      },
    }),
    /simulated migration failure/,
  );

  assert.equal(database.destroyedReleaseCount, 1);
  assert.equal(database.migrationTableExists, false);
  assert.equal(database.schemaReady, false);
  assert.match(String(warnings[0]?.[0] ?? ''), /Failed to roll back/);
});

test('migration retries only a transient PostgreSQL lock failure in a fresh transaction', async () => {
  const database = createDatabase({ transientLockFailures: 1 });
  const warnings: string[] = [];
  const result = await migrateManagedWorkflowSchema(createPool(database), {
    logger: {
      log() {},
      warn(message) {
        warnings.push(String(message));
      },
    },
  });

  assert.deepEqual(result, { currentVersion: 10, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.equal(database.queryLog.filter((sql) => sql === 'BEGIN').length, 2);
  assert.equal(database.queryLog.filter((sql) => sql === 'ROLLBACK').length, 1);
  assert.match(warnings[0] ?? '', /transient PostgreSQL error 55P03/);
});

test('logger failures cannot change committed, failed, or retried migration outcomes', async (t) => {
  const throwingLogger = {
    log() {
      throw new Error('simulated log failure');
    },
    warn() {
      throw new Error('simulated warning failure');
    },
  };

  await t.test('committed migration', async () => {
    const result = await migrateManagedWorkflowSchema(createPool(createDatabase()), {
      logger: throwingLogger,
    });
    assert.deepEqual(result, { currentVersion: 10, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  });

  await t.test('failed migration and rollback', async () => {
    const database = createDatabase({ failNextMigration: true, failRollback: true });
    await assert.rejects(
      migrateManagedWorkflowSchema(createPool(database), { logger: throwingLogger }),
      /simulated migration failure/,
    );
    assert.equal(database.destroyedReleaseCount, 1);
  });

  await t.test('transient retry', async () => {
    const database = createDatabase({ transientLockFailures: 1 });
    const result = await migrateManagedWorkflowSchema(createPool(database), {
      logger: throwingLogger,
    });
    assert.deepEqual(result, { currentVersion: 10, appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  });
});
