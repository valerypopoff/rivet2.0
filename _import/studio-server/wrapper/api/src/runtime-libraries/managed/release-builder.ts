import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';

import * as tar from 'tar';

import type { RuntimeLibraryEntry, RuntimeLibraryLogSource } from '../../../../shared/runtime-library-types.js';
import { buildChildProcessEnv, execStreaming } from '../../utils/exec.js';
import { CANCEL_POLL_INTERVAL_MS } from './schema.js';

export async function buildCandidatePackages(
  job: { job_id: string; type: 'install' | 'remove'; packages_json: unknown },
  getActiveReleasePackages: () => Promise<Record<string, RuntimeLibraryEntry>>,
  appendJobLog: (jobId: string, message: string, source?: RuntimeLibraryLogSource) => Promise<void>,
  normalizeJobPackages: (value: unknown) => Array<{ name: string; version: string }>,
): Promise<Record<string, RuntimeLibraryEntry>> {
  const candidatePackages = await getActiveReleasePackages();
  const requestedPackages = normalizeJobPackages(job.packages_json);

  if (job.type === 'install') {
    for (const pkg of requestedPackages) {
      candidatePackages[pkg.name] = {
        name: pkg.name,
        version: pkg.version,
        installedAt: new Date().toISOString(),
      };
      await appendJobLog(job.job_id, `Adding: ${pkg.name}@${pkg.version}`);
    }
  } else {
    for (const pkg of requestedPackages) {
      if (!(pkg.name in candidatePackages)) {
        await appendJobLog(job.job_id, `Warning: ${pkg.name} is not installed, skipping`);
        continue;
      }

      delete candidatePackages[pkg.name];
      await appendJobLog(job.job_id, `Removing: ${pkg.name}`);
    }
  }

  return candidatePackages;
}

export async function buildReleaseArtifact(
  options: {
    job: { job_id: string };
    candidatePackages: Record<string, RuntimeLibraryEntry>;
    jobsRoot: string;
    appendJobLog: (jobId: string, message: string, source?: RuntimeLibraryLogSource) => Promise<void>;
    throwIfCancellationRequested: (jobId: string) => Promise<void>;
    updateJobStatus: (jobId: string, status: 'validating') => Promise<void>;
    registerRunningProcess: (jobId: string, process: ChildProcess | null) => void;
    terminateRunningProcess: (jobId: string, reason: string) => void;
    isCancellationRequested: (jobId: string) => Promise<boolean>;
  },
): Promise<{ archiveBuffer: Buffer; archiveSha256: string }> {
  const {
    job,
    candidatePackages,
    jobsRoot,
    appendJobLog,
    throwIfCancellationRequested,
    updateJobStatus,
    registerRunningProcess,
    terminateRunningProcess,
    isCancellationRequested,
  } = options;

  const jobRoot = path.join(jobsRoot, job.job_id);
  const candidateDir = path.join(jobRoot, 'candidate');
  const archivePath = path.join(jobRoot, 'release.tar');

  fs.rmSync(jobRoot, { recursive: true, force: true });
  fs.mkdirSync(candidateDir, { recursive: true });

  try {
    const dependencies = Object.fromEntries(
      Object.values(candidatePackages)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => [entry.name, entry.version]),
    );

    const packageJson = {
      name: 'rivet-runtime-libraries',
      private: true,
      version: '1.0.0',
      description: 'Managed runtime libraries for Rivet code nodes',
      dependencies,
    };

    fs.writeFileSync(path.join(candidateDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
    await appendJobLog(job.job_id, `Generated package.json with ${Object.keys(dependencies).length} dependencies`);
    await throwIfCancellationRequested(job.job_id);

    if (Object.keys(dependencies).length === 0) {
      fs.mkdirSync(path.join(candidateDir, 'node_modules'), { recursive: true });
      await appendJobLog(job.job_id, 'No dependencies to install, creating empty release');
    } else {
      await appendJobLog(job.job_id, 'Running npm install...');
      const exitCode = await npmInstall(
        job.job_id,
        candidateDir,
        appendJobLog,
        registerRunningProcess,
        terminateRunningProcess,
        isCancellationRequested,
      );
      if (exitCode !== 0) {
        await throwIfCancellationRequested(job.job_id);
        throw new Error(`npm install failed with exit code ${exitCode}`);
      }

      await throwIfCancellationRequested(job.job_id);
      await appendJobLog(job.job_id, 'npm install completed successfully');
    }

    await updateJobStatus(job.job_id, 'validating');
    await appendJobLog(job.job_id, 'Validating installed packages...');
    await throwIfCancellationRequested(job.job_id);
    const validationErrors = validateCandidate(candidateDir, candidatePackages);
    if (validationErrors.length > 0) {
      for (const message of validationErrors) {
        await appendJobLog(job.job_id, `Validation error: ${message}`);
      }

      throw new Error(`Validation failed: ${validationErrors.join('; ')}`);
    }

    await appendJobLog(job.job_id, 'Validation passed');
    await tar.c({
      cwd: candidateDir,
      file: archivePath,
      portable: true,
      noMtime: true,
    }, ['.']);

    const archiveBuffer = fs.readFileSync(archivePath);
    const archiveSha256 = createHash('sha256').update(archiveBuffer).digest('hex');

    return { archiveBuffer, archiveSha256 };
  } finally {
    fs.rmSync(jobRoot, { recursive: true, force: true });
  }
}

async function npmInstall(
  jobId: string,
  cwd: string,
  appendJobLog: (jobId: string, message: string, source?: RuntimeLibraryLogSource) => Promise<void>,
  registerRunningProcess: (jobId: string, process: ChildProcess | null) => void,
  terminateRunningProcess: (jobId: string, reason: string) => void,
  isCancellationRequested: (jobId: string) => Promise<boolean>,
): Promise<number> {
  return new Promise((resolve) => {
    const child = execStreaming('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd,
      env: buildChildProcessEnv(),
      timeoutMs: 300_000,
    });
    registerRunningProcess(jobId, child.process);

    const cancelPoll = setInterval(() => {
      void isCancellationRequested(jobId).then((isCancelled) => {
        if (isCancelled) {
          void appendJobLog(jobId, 'Cancellation requested; terminating npm install...').catch(() => {});
          terminateRunningProcess(jobId, 'Cancellation requested by user.');
        }
      }).catch((error) => {
        console.error('[runtime-libraries] Failed to check cancellation during npm install:', error);
      });
    }, CANCEL_POLL_INTERVAL_MS);
    cancelPoll.unref?.();

    const cleanup = () => {
      clearInterval(cancelPoll);
      registerRunningProcess(jobId, null);
    };

    child.on('data', (source, data) => {
      const lines = data.split('\n').filter((line) => line.trim());
      for (const line of lines) {
        void appendJobLog(jobId, line, source);
      }
    });

    child.on('exit', (code) => {
      cleanup();
      resolve(code);
    });

    child.on('error', (error) => {
      cleanup();
      void appendJobLog(jobId, `Process error: ${error.message}`, 'system');
      resolve(1);
    });
  });
}

function validateCandidate(candidateDir: string, packages: Record<string, RuntimeLibraryEntry>): string[] {
  const packageNames = Object.keys(packages);
  if (packageNames.length === 0) {
    return [];
  }

  const nodeModulesPath = path.join(candidateDir, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    return ['node_modules directory not found'];
  }

  const errors: string[] = [];
  const virtualEntry = path.join(nodeModulesPath, '__validate.cjs');
  try {
    const req = createRequire(virtualEntry);
    for (const name of packageNames) {
      try {
        req.resolve(name);
      } catch {
        errors.push(`Package "${name}" could not be resolved from the candidate release`);
      }
    }
  } catch (error) {
    errors.push(`createRequire failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return errors;
}
