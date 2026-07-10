import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportTiming, startTimer } from './ci-timing.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yarnPath = path.join(repoRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs');

const targets = {
  runtime: ['@valerypopoff/rivet2-core', '@valerypopoff/rivet2-node'],
  'hosted-web-deps': ['@valerypopoff/rivet2-core', '@valerypopoff/trivet'],
  'executor-runtime': ['@valerypopoff/rivet2-core', '@valerypopoff/rivet2-node', '@valerypopoff/rivet-app-executor'],
  'npm-public': [
    '@valerypopoff/rivet2-core',
    '@valerypopoff/rivet2-node',
    '@valerypopoff/trivet',
    '@valerypopoff/rivet2-cli',
  ],
};

const targetName = process.argv[2];

if (!targetName || !targets[targetName]) {
  console.error(`Usage: node scripts/build-wrapper-target.mjs <${Object.keys(targets).join('|')}>`);
  process.exit(1);
}

for (const workspace of targets[targetName]) {
  console.log(`\nBuilding ${workspace} for ${targetName}...`);
  const startedAt = startTimer();

  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=8192', yarnPath, 'workspace', workspace, 'run', 'build'],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    },
  );

  await reportTiming(`${targetName}: ${workspace} build`, startedAt);

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
