import { runBackendSupervisor } from '../images/api/backend-supervisor.mjs';

const workspaceRoot = '/workspace';
const bootstrapOptions =
  `${process.env.NODE_OPTIONS ?? ''} --import=${workspaceRoot}/packages/studio-server-bootstrap/bootstrap.mjs`.trim();

process.exitCode = await runBackendSupervisor({
  localUpgradeProvisionCommand: [
    process.execPath,
    '--import',
    `${workspaceRoot}/node_modules/tsx/dist/loader.mjs`,
    `${workspaceRoot}/packages/studio-server-api/src/scripts/local-metadata-control.ts`,
    '--provision',
  ],
  apiCommand: [process.execPath, `${workspaceRoot}/deploy/studio-server/scripts/watch-api-workspace-dependencies.mjs`],
  executorCommand: [process.execPath, `${workspaceRoot}/packages/studio-server-executor/build/watch-executor.cjs`],
  executorCwd: workspaceRoot,
  apiEnvOverrides: { NODE_OPTIONS: bootstrapOptions },
  executorEnvOverrides: {
    NODE_OPTIONS: '',
    RIVET_EXECUTOR_CHILD_NODE_OPTIONS: bootstrapOptions,
  },
});
