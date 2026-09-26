import { startBackendSupervisor } from '../images/api/backend-supervisor.mjs';

const workspaceRoot = '/workspace';
const bootstrapOptions =
  `${process.env.NODE_OPTIONS ?? ''} --import=${workspaceRoot}/packages/studio-server-bootstrap/bootstrap.mjs`.trim();

const supervisor = await startBackendSupervisor({
  apiCommand: [process.execPath, `${workspaceRoot}/deploy/studio-server/scripts/watch-api-workspace-dependencies.mjs`],
  executorCommand: [process.execPath, `${workspaceRoot}/packages/studio-server-executor/build/watch-executor.cjs`],
  executorCwd: workspaceRoot,
  apiEnvOverrides: { NODE_OPTIONS: bootstrapOptions },
  executorEnvOverrides: {
    NODE_OPTIONS: '',
    RIVET_EXECUTOR_CHILD_NODE_OPTIONS: bootstrapOptions,
  },
});

process.exitCode = await supervisor.completed;
