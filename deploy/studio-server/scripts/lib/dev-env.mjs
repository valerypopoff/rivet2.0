import fs from 'node:fs';
import path from 'node:path';
import { parseEnvFile } from './env.mjs';

export function loadDevEnv(rootDir) {
  const explicitEnvFile = String(process.env.RIVET_ENV_FILE ?? '').trim();
  const envCandidates = explicitEnvFile
    ? [path.isAbsolute(explicitEnvFile) ? explicitEnvFile : path.resolve(rootDir, explicitEnvFile)]
    : ['.env', '.env.dev'].map((name) => path.join(rootDir, name));
  const envPath = envCandidates.find((candidate) => fs.existsSync(candidate)) ?? envCandidates[0];
  const hasEnvFile = fs.existsSync(envPath);
  const fileEnv = parseEnvFile(envPath);
  const mergedEnv = {
    ...process.env,
    ...fileEnv,
  };

  if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKSPACE_ROOT')) {
    mergedEnv.RIVET_WORKSPACE_ROOT = rootDir;
  }

  if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_APP_DATA_ROOT')) {
    mergedEnv.RIVET_APP_DATA_ROOT = path.join(rootDir, '.data', 'rivet-app');
  }

  if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBRARIES_ROOT')) {
    mergedEnv.RIVET_RUNTIME_LIBRARIES_ROOT = path.join(rootDir, '.data', 'runtime-libraries');
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_ARTIFACTS_HOST_PATH')) {
    const artifactsRoot = path.resolve(rootDir, fileEnv.RIVET_ARTIFACTS_HOST_PATH);

    if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOWS_HOST_PATH')) {
      mergedEnv.RIVET_WORKFLOWS_HOST_PATH = path.join(artifactsRoot, 'workflows');
    }

    if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOW_RECORDINGS_HOST_PATH')) {
      mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH = path.join(artifactsRoot, 'workflow-recordings');
    }

    if (!Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBS_HOST_PATH')) {
      mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH = path.join(artifactsRoot, 'runtime-libraries');
    }
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOWS_HOST_PATH')) {
    mergedEnv.RIVET_WORKFLOWS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_WORKFLOWS_HOST_PATH);
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_WORKFLOW_RECORDINGS_HOST_PATH')) {
    mergedEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_WORKFLOW_RECORDINGS_HOST_PATH);
  }

  if (Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_RUNTIME_LIBS_HOST_PATH')) {
    mergedEnv.RIVET_RUNTIME_LIBS_HOST_PATH = path.resolve(rootDir, fileEnv.RIVET_RUNTIME_LIBS_HOST_PATH);
  }

  return { envPath, hasEnvFile, fileEnv, mergedEnv };
}
