import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSchemaRepositoryReceipt } from './schema-compatibility-probe.mjs';

/** Optional local exact-image check on the schema gate's disposable PostgreSQL.
 * No registry pulls, cloud credentials or caller-provided database are accepted.
 * Module mounts are diagnostic source-built checks, never exact-image evidence. */
export async function verifySchemaImagePair(docker, postgresId, env = process.env) {
  const images = [env.RIVET_SCHEMA_PREDECESSOR_IMAGE, env.RIVET_SCHEMA_CANDIDATE_IMAGE];
  if (images.every((i) => !i)) return;
  assert.ok(
    images.every((i) => /^(?:sha256:)?[a-f0-9]{12,64}$/.test(i ?? '')),
    'Use two immutable locally cached image IDs',
  );
  const runId = randomUUID().replaceAll('-', ''),
    network = `rivet-schema-${runId}`;
  const root = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
  const ids = [];
  let networkId;
  let connected = false;
  let primary;
  try {
    networkId = docker('network', 'create', '--internal', network);
    docker('network', 'connect', '--alias', 'release-gate-postgres', networkId, postgresId);
    connected = true;
    for (const [i, role] of ['previous', 'candidate'].entries()) {
      const mounts = [
        '--mount',
        `type=bind,src=${path.join(root, 'deploy/studio-server/scripts/fixtures/schema-compatibility-worker.mjs')},dst=/probe/worker.mjs,readonly`,
        '--mount',
        `type=bind,src=${path.join(root, 'deploy/studio-server/scripts/lib/schema-compatibility-probe.mjs')},dst=/probe/schema-compatibility-probe.mjs,readonly`,
      ];
      const modules = env[i === 0 ? 'RIVET_SCHEMA_PREDECESSOR_MODULES' : 'RIVET_SCHEMA_CANDIDATE_MODULES'];
      if (modules)
        mounts.push(
          '--mount',
          `type=bind,src=${path.resolve(modules)},dst=/app/packages/studio-server-api/dist,readonly`,
        );
      ids.push(
        docker(
          'create',
          '--pull',
          'never',
          '--network',
          networkId,
          '--entrypoint',
          'node',
          ...mounts,
          '-e',
          'RIVET_SCHEMA_COMPATIBILITY_FIXTURE=isolated',
          '-e',
          `RIVET_SCHEMA_PROBE_ROLE=${role}`,
          '-e',
          `RIVET_SCHEMA_PROBE_ID=${runId}`,
          '-e',
          `RIVET_SCHEMA_PROBE_VERSION=${i === 0 ? 17 : 18}`,
          '-e',
          'RIVET_SCHEMA_PROBE_TARGET=18',
          '-e',
          'RIVET_SCHEMA_PROBE_DATABASE=rivet_rolling_schema_check',
          '-e',
          'RIVET_SCHEMA_PROBE_USER=postgres',
          images[i],
          '/probe/worker.mjs',
        ),
      );
    }
    const results = await Promise.allSettled(
      ids.map(
        (id) =>
          new Promise((resolve, reject) => {
            const child = spawn('docker', ['start', '--attach', id], {
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            const timer = setTimeout(() => {
              child.kill();
              reject(Error('Schema image fixture exceeded its deadline'));
            }, 90000);
            child.stdout.on('data', (b) => {
              output += b;
            });
            child.stderr.on('data', (b) => {
              output += b;
            });
            child.on('error', (e) => {
              clearTimeout(timer);
              reject(e);
            });
            child.on('close', (code) => {
              clearTimeout(timer);
              code === 0 ? resolve(output) : reject(Error(`Schema image worker failed: ${output.slice(-4000)}`));
            });
          }),
      ),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') throw result.reason;
      readSchemaRepositoryReceipt(result.value, {
        role: index === 0 ? 'previous' : 'candidate',
        version: index === 0 ? 17 : 18,
        runId,
      });
    }
    console.log(
      'Schema repositories: historical 17 / candidate 18 mixed writes and cross-reads passed' +
        (env.RIVET_SCHEMA_PREDECESSOR_MODULES || env.RIVET_SCHEMA_CANDIDATE_MODULES
          ? ' (source overlays; not release-image qualification).'
          : ' (cached exact images).'),
    );
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    const failures = [];
    const cleanup = (...args) => {
      try {
        docker(...args);
      } catch (error) {
        failures.push(error);
      }
    };
    for (const id of ids) cleanup('rm', '-f', '-v', id);
    if (networkId) {
      if (connected) cleanup('network', 'disconnect', networkId, postgresId);
      cleanup('network', 'rm', networkId);
    }
    if (failures.length)
      throw new AggregateError(
        primary ? [primary, ...failures] : failures,
        'Exact local schema fixture cleanup is incomplete',
      );
  }
}
