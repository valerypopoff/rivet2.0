import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yarnPath = path.join(repoRoot, '.yarn', 'releases', 'yarn-4.17.1.cjs');
const args = new Set(process.argv.slice(2));

function workspaceBuildPhase(label, workspace) {
  return {
    label,
    command: process.execPath,
    args: ['--max-old-space-size=8192', yarnPath, 'workspace', workspace, 'run', 'build'],
  };
}

const phases = [
  !args.has('--skip-install') && {
    label: 'yarn install',
    command: process.execPath,
    args: [yarnPath, 'install', '--immutable'],
  },
  workspaceBuildPhase('core build', '@valerypopoff/rivet2-core'),
  workspaceBuildPhase('node build', '@valerypopoff/rivet2-node'),
  workspaceBuildPhase('trivet build', '@valerypopoff/trivet'),
  workspaceBuildPhase('app-executor build', '@valerypopoff/rivet-app-executor'),
  !args.has('--skip-app') && workspaceBuildPhase('app build', '@valerypopoff/rivet-app'),
].filter(Boolean);

const timings = [];

for (const phase of phases) {
  console.log(`\n== ${phase.label} ==`);
  const startedAt = performance.now();
  const result = spawnSync(phase.command, phase.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  const durationMs = performance.now() - startedAt;

  timings.push({
    phase: phase.label,
    seconds: Number((durationMs / 1000).toFixed(3)),
  });

  if (result.status !== 0) {
    console.error(`\n${phase.label} failed after ${(durationMs / 1000).toFixed(3)}s.`);
    process.exit(result.status ?? 1);
  }
}

console.log('\nBuild phase timing summary:');
for (const timing of timings) {
  console.log(`${timing.phase}: ${timing.seconds}s`);
}
