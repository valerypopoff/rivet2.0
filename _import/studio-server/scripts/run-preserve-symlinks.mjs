import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.error('Usage: node scripts/run-preserve-symlinks.mjs <command> [...args]');
  process.exit(1);
}

function appendNodeOption(current, option) {
  const options = (current ?? '').split(/\s+/).filter(Boolean);
  if (!options.includes(option)) {
    options.push(option);
  }
  return options.join(' ');
}

const env = {
  ...process.env,
  NODE_OPTIONS: appendNodeOption(process.env.NODE_OPTIONS, '--preserve-symlinks'),
};

function resolveCommand(command, args) {
  if (process.platform === 'win32' && command === 'tsx') {
    const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    if (fs.existsSync(tsxCliPath)) {
      return {
        command: process.execPath,
        args: [tsxCliPath, ...args],
      };
    }
  }

  return { command, args };
}

const resolved = resolveCommand(command, args);
const child = spawn(resolved.command, resolved.args, {
  env,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`[run-preserve-symlinks] Failed to run ${resolved.command}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
