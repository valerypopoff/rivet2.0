import { runBackendSupervisor } from '../images/api/backend-supervisor.mjs';
import { fileURLToPath } from 'node:url';

export function devBackendSupervisorOptions(workspaceRoot = '/workspace', env = process.env) {
  const bootstrapOptions =
    `${env.NODE_OPTIONS ?? ''} --import=${workspaceRoot}/packages/studio-server-bootstrap/bootstrap.mjs`.trim();
  const controlCommand = [
    process.execPath,
    '--import',
    `${workspaceRoot}/node_modules/tsx/dist/loader.mjs`,
    `${workspaceRoot}/packages/studio-server-api/src/scripts/local-metadata-control.ts`,
  ];

  return {
    localStorageInitializeCommand: [...controlCommand, '--initialize-empty'],
    localUpgradeProvisionCommand: [...controlCommand, '--provision'],
    apiCommand: [
      process.execPath,
      `${workspaceRoot}/deploy/studio-server/scripts/watch-api-workspace-dependencies.mjs`,
    ],
    executorCommand: [process.execPath, `${workspaceRoot}/packages/studio-server-executor/build/watch-executor.cjs`],
    executorCwd: workspaceRoot,
    apiEnvOverrides: { NODE_OPTIONS: bootstrapOptions },
    executorEnvOverrides: {
      NODE_OPTIONS: '',
      RIVET_EXECUTOR_CHILD_NODE_OPTIONS: bootstrapOptions,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await runBackendSupervisor(devBackendSupervisorOptions());
