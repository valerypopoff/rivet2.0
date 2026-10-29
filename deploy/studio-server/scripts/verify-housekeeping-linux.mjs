import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const folder = 'deploy/studio-server/images/api';
const files = ['maintenance-lock.test.mjs', 'housekeeping-supervisor.test.mjs'].map((f) => `${folder}/${f}`);
files.push('deploy/studio-server/scripts/temporary-staging-linux.test.mjs');
files.push('deploy/studio-server/scripts/temporary-staging-actor.test.mjs');
const result =
  process.platform === 'linux'
    ? spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
    : spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--entrypoint',
          'node',
          '--mount',
          `type=bind,source=${path.resolve(folder)},target=/workspace/${folder},readonly`,
          '--mount',
          `type=bind,source=${path.resolve('deploy/studio-server/scripts')},target=/workspace/deploy/studio-server/scripts,readonly`,
          process.env.RIVET_HOUSEKEEPING_TEST_IMAGE || 'node:24-alpine',
          '--test',
          ...files.map((f) => `/workspace/${f}`),
        ],
        { stdio: 'inherit', windowsHide: true },
      );
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
