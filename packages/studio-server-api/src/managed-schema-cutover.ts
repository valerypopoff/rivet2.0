import fs from 'node:fs/promises';
import https from 'node:https';
import type { Pool } from 'pg';
import {
  MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE,
  MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION,
} from './routes/workflows/managed/schema-migrations.js';

export const SCHEMA_READER_ANNOTATION = 'rivet.dev/managed-schema-reader-version';
type Resource = {
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: { replicas?: number; template?: { metadata?: { annotations?: Record<string, string> } } };
};
type List = { items: Resource[] };

/** Fail closed for unknown readers, including terminating pods. A controller
 * with nonzero desired replicas can recreate an old reader after the check. */
export function assertManagedSchemaReadersCompatible(
  lists: { pods: List; deployments: List; statefulsets: List; autoscalers: List },
  release: string,
  minimumReaderVersion = MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION,
): void {
  const owned = (resource: Resource) => resource.metadata?.labels?.['app.kubernetes.io/instance'] === release;
  const reader = (resource: Resource) =>
    !['proxy', 'web', 'workflow-schema-migration'].includes(
      resource.metadata?.labels?.['app.kubernetes.io/component'] ?? '',
    );
  const compatible = (resource: Resource, pod: boolean) => {
    const raw = (pod ? resource.metadata : resource.spec?.template?.metadata)?.annotations?.[SCHEMA_READER_ANNOTATION];
    return raw != null && /^\d+$/.test(raw) && Number(raw) >= minimumReaderVersion;
  };
  for (const pod of lists.pods.items.filter(owned).filter(reader)) {
    if (!compatible(pod, true))
      throw new Error(
        'Schema migration blocked: an older or unknown reader pod still exists. Use the maintenance cutover.',
      );
  }
  for (const controller of [...lists.deployments.items, ...lists.statefulsets.items].filter(owned).filter(reader)) {
    if ((controller.spec?.replicas ?? 1) > 0 && !compatible(controller, false))
      throw new Error('Schema migration blocked: an older or unknown reader controller can still create pods.');
  }
  // A paused incompatible controller must not be brought back by its HPA.
  if (
    lists.autoscalers.items.some(owned) &&
    [...lists.deployments.items, ...lists.statefulsets.items]
      .filter(owned)
      .filter(reader)
      .some((item) => !compatible(item, false))
  )
    throw new Error('Schema migration blocked: autoscaling can recreate an incompatible reader.');
}

async function readKubernetesList(path: string, token: string, ca: Buffer): Promise<List> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443');
  return new Promise((resolve, reject) => {
    const request = https.get(
      {
        hostname: host,
        port,
        path,
        ca,
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Schema reader inventory failed (${response.statusCode ?? 'unknown'}).`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) response.destroy(new Error('Schema reader inventory exceeded its limit.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!Array.isArray(value.items)) throw new Error('Invalid schema reader inventory.');
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
  });
}

/** Direct CLI/Helm migration has the same safety check as the release helper.
 * Standalone operators must acknowledge an offline incompatible cutover. */
export async function assertManagedSchemaMigrationSafe(pool: Pool): Promise<void> {
  if (process.env.KUBERNETES_SERVICE_HOST) {
    const release = process.env.RIVET_SCHEMA_MIGRATION_RELEASE;
    if (!release) throw new Error('Kubernetes schema migration requires its release identity.');
    const root = '/var/run/secrets/kubernetes.io/serviceaccount';
    const [token, ca, namespace] = await Promise.all([
      fs.readFile(`${root}/token`, 'utf8'),
      fs.readFile(`${root}/ca.crt`),
      fs.readFile(`${root}/namespace`, 'utf8'),
    ]);
    const ns = encodeURIComponent(namespace.trim());
    const selector = `?labelSelector=${encodeURIComponent(`app.kubernetes.io/instance=${release}`)}`;
    const [pods, deployments, statefulsets, autoscalers] = await Promise.all([
      readKubernetesList(`/api/v1/namespaces/${ns}/pods${selector}`, token.trim(), ca),
      readKubernetesList(`/apis/apps/v1/namespaces/${ns}/deployments${selector}`, token.trim(), ca),
      readKubernetesList(`/apis/apps/v1/namespaces/${ns}/statefulsets${selector}`, token.trim(), ca),
      readKubernetesList(`/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers${selector}`, token.trim(), ca),
    ]);
    assertManagedSchemaReadersCompatible({ pods, deployments, statefulsets, autoscalers }, release);
    return;
  }
  const table = await pool.query('SELECT to_regclass($1) AS name', [MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE]);
  const result = table.rows[0]?.name
    ? await pool.query(`SELECT MAX(version) AS version FROM ${MANAGED_WORKFLOW_SCHEMA_MIGRATIONS_TABLE}`)
    : undefined;
  const current = Number(result?.rows[0]?.version ?? 0);
  // An unversioned catalog is not necessarily empty: older releases may have
  // created workflows before introducing the migration ledger.
  const legacy = current === 0 ? await pool.query("SELECT to_regclass('workflows') AS name") : undefined;
  if (
    (current > 0 || legacy?.rows[0]?.name) &&
    current < MINIMUM_ROLLBACK_COMPATIBLE_MANAGED_WORKFLOW_SCHEMA_VERSION &&
    process.env.RIVET_MANAGED_SCHEMA_OFFLINE !== '1'
  )
    throw new Error(
      'Incompatible schema migration requires all readers and writers stopped. After verifying that, set RIVET_MANAGED_SCHEMA_OFFLINE=1 for this operator command.',
    );
}
