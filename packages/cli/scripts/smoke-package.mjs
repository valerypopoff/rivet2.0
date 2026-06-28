import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkspace,
  cleanPackageRuntimeEnv,
  packageDir,
  packBuiltWorkspace,
  readTgzEntries,
  run,
  runNpm,
} from './smoke-helpers.mjs';

const exampleProject = join(packageDir, 'cli-example.rivet-project');
const tempDir = await mkdtemp(join(tmpdir(), 'rivet-cli-package-smoke-'));
const packageRuntimeEnv = cleanPackageRuntimeEnv();

try {
  const packagePaths = {
    cli: join(tempDir, 'rivet2-cli.tgz'),
    core: join(tempDir, 'rivet2-core.tgz'),
    node: join(tempDir, 'rivet2-node.tgz'),
  };

  buildWorkspace('@valerypopoff/rivet2-core');
  buildWorkspace('@valerypopoff/rivet2-node');
  buildWorkspace('@valerypopoff/rivet2-cli');
  await packBuiltWorkspace('packages/core', packagePaths.core, tempDir);
  await packBuiltWorkspace('packages/node', packagePaths.node, tempDir);
  await packBuiltWorkspace('packages/cli', packagePaths.cli, tempDir);

  const entries = await readTgzEntries(packagePaths.cli);
  for (const expectedEntry of [
    'package/bin/cli.js',
    'package/bin/commands/list.js',
    'package/bin/commands/doctor.js',
    'package/bin/commands/serveApp.js',
    'package/dist/types/cli.d.ts',
    'package/package.json',
  ]) {
    assert.ok(entries.includes(expectedEntry), `Packed CLI is missing ${expectedEntry}`);
  }

  await writeFile(join(tempDir, 'package.json'), '{"private":true,"type":"module"}\n', 'utf8');
  runNpm(['install', '--ignore-scripts', packagePaths.core, packagePaths.node, packagePaths.cli], tempDir);

  const installedReadme = await readFile(
    join(tempDir, 'node_modules/@valerypopoff/rivet2-cli/README.md'),
    'utf8',
  );
  assert.match(installedReadme, /^# @valerypopoff\/rivet2-cli/m);

  const cliBin = join(tempDir, 'node_modules/@valerypopoff/rivet2-cli/bin/cli.js');
  const listOutput = run('node', [cliBin, 'list', exampleProject], tempDir, packageRuntimeEnv);
  assert.match(listOutput, /Project:/);
  assert.match(listOutput, /Graphs:/);

  const doctorOutput = run('node', [cliBin, 'doctor', exampleProject], tempDir, packageRuntimeEnv);
  assert.match(doctorOutput, /Rivet project doctor/);

  const binHelpOutput = runNpm(['exec', '--offline', '--', 'rivet', '--help'], tempDir, packageRuntimeEnv);
  assert.match(binHelpOutput, /doctor/);
  assert.match(binHelpOutput, /serve-app/);

  const runOutput = run(
    'node',
    [cliBin, 'run', exampleProject, 'Passthrough', '--input', 'input=hello', '--unwrap-output', 'output'],
    tempDir,
    packageRuntimeEnv,
  );
  assert.equal(JSON.parse(runOutput), 'hello');

  console.log('CLI package smoke passed.');
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
