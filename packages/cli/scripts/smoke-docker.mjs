import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkspace,
  packageDir,
  packBuiltWorkspace,
  run,
} from './smoke-helpers.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'rivet-cli-docker-smoke-'));
const imageTag = 'rivet2-cli-smoke:local';
let dockerAvailable = false;

try {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  dockerAvailable = true;
  buildWorkspace('@valerypopoff/rivet2-core');
  buildWorkspace('@valerypopoff/rivet2-node');
  buildWorkspace('@valerypopoff/rivet2-cli');
  await packBuiltWorkspace('packages/core', join(tempDir, 'rivet2-core.tgz'), tempDir);
  await packBuiltWorkspace('packages/node', join(tempDir, 'rivet2-node.tgz'), tempDir);
  await packBuiltWorkspace('packages/cli', join(tempDir, 'rivet2-cli.tgz'), tempDir);
  await copyFile(join(packageDir, 'entrypoint.sh'), join(tempDir, 'entrypoint.sh'));
  await writeFile(
    join(tempDir, 'Dockerfile'),
    `FROM node:23.11.0-alpine3.21
WORKDIR /app
VOLUME /project
COPY rivet2-core.tgz /tmp/rivet2-core.tgz
COPY rivet2-node.tgz /tmp/rivet2-node.tgz
COPY rivet2-cli.tgz /tmp/rivet2-cli.tgz
RUN npm install -g --ignore-scripts /tmp/rivet2-core.tgz /tmp/rivet2-node.tgz /tmp/rivet2-cli.tgz
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
`,
    'utf8',
  );

  run('docker', ['build', '-t', imageTag, tempDir]);

  const listOutput = run('docker', [
    'run',
    '--rm',
    '-v',
    `${packageDir}:/project`,
    imageTag,
    'list',
    '/project/cli-example.rivet-project',
  ]);
  assert.match(listOutput, /Project:/);
  assert.match(listOutput, /Graphs:/);

  const doctorOutput = run('docker', [
    'run',
    '--rm',
    '-v',
    `${packageDir}:/project`,
    imageTag,
    'doctor',
    '/project/cli-example.rivet-project',
  ]);
  assert.match(doctorOutput, /Rivet project doctor/);

  const helpOutput = run('docker', ['run', '--rm', imageTag, '--help']);
  assert.match(helpOutput, /doctor/);
  assert.match(helpOutput, /serve-app/);

  console.log(`CLI Docker smoke passed for ${imageTag}.`);
} finally {
  if (dockerAvailable) {
    tryRun('docker', ['image', 'rm', '-f', imageTag]);
  }

  await rm(tempDir, { force: true, recursive: true });
}

function tryRun(command, args) {
  try {
    run(command, args);
  } catch {
    // Best-effort cleanup must not hide the original smoke failure.
  }
}
