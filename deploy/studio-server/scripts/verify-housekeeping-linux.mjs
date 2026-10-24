import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root = process.cwd();
const files = ['maintenance-lock.test.mjs', 'housekeeping-supervisor.test.mjs'];
const folder = 'deploy/studio-server/images/api';
const result =
  process.platform === 'linux'
    ? spawnSync(process.execPath, ['--test', ...files.map((f) => path.join(folder, f))], { stdio: 'inherit' })
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
          `type=bind,source=${path.resolve(folder)},target=/tests/images/api,readonly`,
          '--mount',
          `type=bind,source=${path.resolve('deploy/studio-server/scripts/lib/housekeeping-handover.mjs')},target=/tests/scripts/lib/housekeeping-handover.mjs,readonly`,
          process.env.RIVET_HOUSEKEEPING_TEST_IMAGE || 'node:24-alpine',
          '--test',
          ...files.map((f) => `/tests/images/api/${f}`),
        ],
        { stdio: 'inherit', windowsHide: true },
      );
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
