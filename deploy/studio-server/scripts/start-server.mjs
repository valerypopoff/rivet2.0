import fs from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
const args = process.argv.slice(3).filter((value, index) => value !== '--' || index !== 0);
let programArgs;
try {
  if (mode === 'vm') {
    if (args.length)
      throw new Error('Use RIVET_ENV_FILE to select VM settings; the VM start command takes no arguments.');
    console.log('studio-server:vm now aliases dev:local-storage (Docker, no Kubernetes).');
    programArgs = ['deploy/studio-server/scripts/container-server.mjs', 'dev', 'local-storage'];
  } else if (mode === 'prod') {
    const file = process.env.RIVET_ENV_FILE || '.env';
    if (!fs.existsSync(file)) throw new Error('Create a private .env from deploy/studio-server/.env.example first.');
    programArgs = ['deploy/studio-server/scripts/container-server.mjs', 'prod', 'external-storage', ...args];
  } else throw new Error('Select vm or prod.');
  const child = spawn(process.execPath, programArgs, { env: process.env, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
