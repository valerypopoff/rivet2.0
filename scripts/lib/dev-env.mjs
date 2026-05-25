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

  const explicitRivetSourceHostPath = Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_SOURCE_HOST_PATH')
    ? String(fileEnv.RIVET_SOURCE_HOST_PATH ?? '').trim()
    : String(process.env.RIVET_SOURCE_HOST_PATH ?? '').trim();
  const rivetSourceHostPath = explicitRivetSourceHostPath
    ? path.resolve(rootDir, explicitRivetSourceHostPath)
    : path.join(rootDir, 'rivet');
  mergedEnv.RIVET_SOURCE_HOST_PATH = fs.existsSync(rivetSourceHostPath)
    ? fs.realpathSync.native(rivetSourceHostPath)
    : rivetSourceHostPath;

  const explicitRivetSourceBuildContextPath = Object.prototype.hasOwnProperty.call(fileEnv, 'RIVET_SOURCE_BUILD_CONTEXT_PATH')
    ? String(fileEnv.RIVET_SOURCE_BUILD_CONTEXT_PATH ?? '').trim()
    : String(process.env.RIVET_SOURCE_BUILD_CONTEXT_PATH ?? '').trim();
  mergedEnv.RIVET_SOURCE_BUILD_CONTEXT_PATH = explicitRivetSourceBuildContextPath
    ? path.resolve(rootDir, explicitRivetSourceBuildContextPath)
    : path.join(rootDir, '.data', 'docker-contexts', 'rivet-source');

  const explicitRivetDependencyBuildContextPath = Object.prototype.hasOwnProperty.call(
    fileEnv,
    'RIVET_DEPENDENCY_BUILD_CONTEXT_PATH',
  )
    ? String(fileEnv.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH ?? '').trim()
    : String(process.env.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH ?? '').trim();
  mergedEnv.RIVET_DEPENDENCY_BUILD_CONTEXT_PATH = explicitRivetDependencyBuildContextPath
    ? path.resolve(rootDir, explicitRivetDependencyBuildContextPath)
    : path.join(rootDir, '.data', 'docker-contexts', 'rivet-dependency-metadata');

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
