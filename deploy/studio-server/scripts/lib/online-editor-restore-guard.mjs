import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Run in a retained published execution Pod so replacing either editor cannot
// interrupt the session. Reuse the installed image's coordinator implementation.
const hold = String.raw`
import { createInterface } from 'node:readline';
import { LegacyRestoreControl } from '/app/packages/studio-server-api/dist/studio-server-api/src/legacy-restore/control.js';
import { getPostgresAppSettingsPoolConfigFromEnv } from '/app/packages/studio-server-api/dist/studio-server-api/src/app-settings/managed-settings-store.js';
const [schema, allowance, reserve] = process.argv.slice(1).map(Number);
const control = new LegacyRestoreControl({
  ...getPostgresAppSettingsPoolConfigFromEnv(), statement_timeout: 5000,
}, process.env.RIVET_APP_SETTINGS_ENCRYPTION_KEY || process.env.RIVET_KEY, 1);
let client;
try {
  if (process.env.RIVET_LEGACY_RESTORE_ENABLED !== '1') throw Error('Restore control unavailable');
  await control.assertDeployment(process.env.RIVET_LEGACY_RESTORE_INSTALLATION);
  client = await control.lock();
  const restore = (await client.query(
    "SELECT journal->>'phase' AS phase FROM rivet_restore_control.operation WHERE singleton=TRUE",
  )).rows[0];
  if (restore && !['completed', 'cancelled'].includes(restore.phase)) throw Error('Restore is active');
  const foundSchema = (await client.query(
    'SELECT max(version) AS version FROM managed_workflow_schema_migrations',
  )).rows[0]?.version;
  if (Number(foundSchema) !== schema) throw Error('Unexpected schema');
  for await (const _ of createInterface({ input: process.stdin })) {
    const result = (await client.query(
      "SELECT current_setting('max_connections')::int AS maximum, count(*)::int AS used " +
      "FROM pg_stat_activity WHERE backend_type = 'client backend' OR backend_type IS NULL",
    )).rows[0];
    if (result.maximum < allowance || result.used >= allowance - reserve) throw Error('Database headroom is unconfirmed');
    process.stdout.write('held\n');
  }
} catch {
  process.stdout.write('blocked\n');
  process.exitCode = 1;
} finally {
  if (client) await control.unlock(client);
  await control.dispose();
}
`;

export async function openOnlineEditorRestoreGuard({
  kubectl,
  context,
  namespace,
  pod,
  schema,
  postgres,
  cwd,
  launch = spawn,
}) {
  if (
    !Number.isSafeInteger(schema) ||
    ![postgres?.maxConnections, postgres?.reservedConnections].every(Number.isSafeInteger) ||
    !context ||
    !namespace ||
    !pod
  )
    throw Error('Editor adoption restore guard inputs are incomplete');
  const child = launch(
    kubectl,
    [
      '--context',
      context,
      '--namespace',
      namespace,
      'exec',
      '-i',
      pod,
      '-c',
      'api',
      '--',
      '/bin/sh',
      '-ec',
      '. /opt/rivet/lib/load-env.sh; load_optional_dotenv_preserving_deployment_storage /vault/dotenv; exec node --input-type=module -e "$1" "$2" "$3" "$4"',
      'rivet-editor-adoption',
      hold,
      String(schema),
      String(postgres.maxConnections),
      String(postgres.reservedConnections),
    ],
    { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let closed = false;
  const ended = new Promise((resolve) => {
    const end = () => {
      closed = true;
      resolve();
    };
    child.once('error', end);
    child.once('close', end);
    child.stdin.on('error', end);
  });
  const lines = createInterface({ input: child.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const check = async () => {
    if (closed) throw Error('Editor adoption lost its PostgreSQL restore-coordinator session');
    child.stdin.write('check\n');
    let timer;
    try {
      const response = await Promise.race([
        replies.next(),
        ended.then(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 15_000);
        }),
      ]);
      if (closed || response?.value !== 'held')
        throw Error('Restore coordinator, installed schema or live database headroom is unconfirmed');
    } finally {
      clearTimeout(timer);
    }
  };
  const close = async () => {
    child.stdin.end();
    let timer;
    await Promise.race([
      ended,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) child.kill();
    lines.close();
  };
  try {
    await check();
    return { check, close };
  } catch (error) {
    await close();
    throw error;
  }
}
