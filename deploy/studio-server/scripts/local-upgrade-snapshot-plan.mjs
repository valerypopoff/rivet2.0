import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const destinations = {
  workflows: '/workflows',
  recordings: '/workflow-recordings',
  appData: '/data/rivet-app',
  runtimeLibraries: '/data/runtime-libraries',
};

/** Read-only discovery. Never return Config.Env, tokens, logs or file contents. */
export function createLocalUpgradeSnapshotPlan(api, executor, { sqlite = false } = {}) {
  assert.equal(api.Config?.Labels?.['com.docker.compose.service'], 'api', 'Expected the API service.');
  const project = api.Config.Labels['com.docker.compose.project'];
  assert.match(project || '', /^[a-z0-9][a-z0-9_-]*$/);
  const roots = {};
  if (sqlite) assert.ok(!executor, 'Selected SQLite requires the combined backend, not a split executor.');
  const expected = { ...destinations, ...(sqlite ? { control: '/data/local-metadata' } : {}) };
  for (const [domain, destination] of Object.entries(expected)) {
    const matches = api.Mounts?.filter((mount) => mount.Destination === destination) || [];
    assert.equal(matches.length, 1, `Expected one persistent ${domain} mount.`);
    const mount = matches[0];
    assert.ok(['bind', 'volume'].includes(mount.Type), 'Business data must be on persistent storage.');
    assert.ok(
      path.posix.isAbsolute(mount.Source) &&
        path.posix.normalize(mount.Source) !== '/' &&
        !mount.Source.split('/').includes('..'),
      'Expected Linux absolute source.',
    );
    if (mount.Type === 'volume') assert.ok(typeof mount.Name === 'string' && mount.Name.length > 0);
    roots[domain] = {
      source: mount.Source,
      destination,
      type: mount.Type,
      ...(mount.Type === 'volume' ? { volume: mount.Name } : {}),
    };
  }
  if (sqlite) {
    const control = (api.Config.Env || []).filter((value) => value.startsWith('RIVET_LOCAL_METADATA_CONTROL_ROOT='));
    assert.deepEqual(
      control,
      ['RIVET_LOCAL_METADATA_CONTROL_ROOT=/data/local-metadata'],
      'Unexpected control mount selection.',
    );
    // All business authorities must use these exact container paths; certificates
    // bind them, and restoring under different paths is not a supported rollback.
    for (const [key, destination] of Object.entries({
      RIVET_WORKFLOWS_ROOT: destinations.workflows,
      RIVET_WORKFLOW_RECORDINGS_ROOT: destinations.recordings,
      RIVET_APP_DATA_ROOT: destinations.appData,
      RIVET_RUNTIME_LIBRARIES_ROOT: destinations.runtimeLibraries,
    }))
      assert.deepEqual(
        (api.Config.Env || []).filter((value) => value.startsWith(key + '=')),
        [key + '=' + destination],
      );
  }
  const sources = Object.values(roots).map((root) => path.posix.normalize(root.source));
  for (let i = 0; i < sources.length; i++)
    for (let j = i + 1; j < sources.length; j++)
      assert.ok(
        sources[i] !== sources[j] &&
          !sources[i].startsWith(sources[j] + '/') &&
          !sources[j].startsWith(sources[i] + '/'),
        'Source roots overlap.',
      );
  const writers = [api];
  if (executor) {
    assert.equal(executor.Config?.Labels?.['com.docker.compose.service'], 'executor');
    assert.equal(executor.Config.Labels['com.docker.compose.project'], project, 'Executor belongs to another stack.');
    for (const [domain, destination] of [
      ['runtimeLibraries', '/data/runtime-libraries'],
      ['appData', '/home/rivet/.local/share/com.valerypopoff.rivet2'],
    ]) {
      const matches = executor.Mounts?.filter((item) => item.Destination === destination) || [];
      assert.equal(matches.length, 1, 'Expected one executor authority mount.');
      assert.ok(['bind', 'volume'].includes(matches[0].Type), 'Executor authority must be persistent.');
      assert.equal(matches[0].Source, roots[domain].source, 'API/executor do not share the expected authority.');
    }
    writers.push(executor);
  }
  const images = writers.map((writer) => {
    assert.match(writer.Image || '', /^sha256:[a-f0-9]{64}$/);
    assert.match(writer.Name || '', /^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    return { container: writer.Name.slice(1), imageId: writer.Image, status: writer.State?.Status };
  });
  return {
    version: sqlite ? 2 : 1,
    mode: 'read-only-plan',
    project,
    roots,
    writers: images,
    knownWritersStopped: writers.every((writer) => writer.State?.Status === 'exited'),
    requires: [
      'Stop all writers and confirm no active work before backup.',
      'Inspect other containers/processes for shared writable mounts.',
      sqlite
        ? 'Preserve all five roots including the selected generation/control and SQLite side files; preserve keys separately.'
        : 'Preserve all four roots and SQLite side files; preserve deployment secrets separately.',
      'Restore an independent copy and certify it before conversion.',
      'No backup, freeze, conversion or container mutation has been performed.',
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 2 || args.length === 4, 'Usage: --api <container> [--executor <container>]');
  assert.equal(args[0], '--api');
  if (args.length === 4) assert.equal(args[2], '--executor');
  const names = [args[1], ...(args.length === 4 ? [args[3]] : [])];
  names.forEach((name) => assert.match(name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
  const result = await execute('docker', ['inspect', ...names], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.length, names.length);
  console.log(JSON.stringify(createLocalUpgradeSnapshotPlan(inspected[0], inspected[1]), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Snapshot discovery refused; check container identity and persistent mounts. No state was changed.');
    process.exitCode = 1;
  });
