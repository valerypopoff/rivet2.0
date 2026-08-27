import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  getRivetYarnEnvironment,
  getRivetYarnInvocation,
} from './lib/rivet-local-dependencies.mjs';

const rootDir = process.cwd();
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-rivet-yarn.mjs <yarn arguments...>');
  process.exit(1);
}

const rivetDir = path.join(rootDir, 'rivet');
const rivetYarnInvocation = getRivetYarnInvocation(rivetDir);
const child = spawn(rivetYarnInvocation.command, [...rivetYarnInvocation.args, ...args], {
  cwd: rivetDir,
  env: {
    ...process.env,
    ...getRivetYarnEnvironment(rootDir, rivetDir),
  },
  shell: false,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[run-rivet-yarn] ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
