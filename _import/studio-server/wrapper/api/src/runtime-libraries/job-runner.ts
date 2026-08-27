import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import {
  currentDir,
  ensureDirectories,
  readManifest,
  stagingDir,
  writeManifest,
  type RuntimeLibraryEntry,
  type RuntimeLibraryManifest,
} from './manifest.js';
import { buildChildProcessEnv, execStreaming } from '../utils/exec.js';
import type { JobStatus, RuntimeLibraryJobLogEntry, RuntimeLibraryLogSource } from '../../../shared/runtime-library-types.js';

export type { JobStatus };
export type JobType = 'install' | 'remove';

export interface JobState {
  id: string;
  type: JobType;
  status: JobStatus;
  packages: Array<{ name: string; version: string }>;
  logs: string[];
  logEntries: RuntimeLibraryJobLogEntry[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastProgressAt: string;
  cancelRequestedAt?: string | null;
}

class JobRunner extends EventEmitter {
  private activeJob: JobState | null = null;
  private jobCounter = 0;
  private activeProcess: ChildProcess | null = null;

  getActiveJob(): JobState | null {
    return this.activeJob;
  }

  getJob(id: string): JobState | null {
    if (this.activeJob?.id === id) {
      return this.activeJob;
    }

    return null;
  }

  isRunning(): boolean {
    return this.activeJob != null &&
      this.activeJob.status !== 'succeeded' &&
      this.activeJob.status !== 'failed';
  }

  startInstall(packages: Array<{ name: string; version: string }>): JobState {
    if (this.isRunning()) {
      throw new Error('A job is already running');
    }

    const job: JobState = {
      id: String(++this.jobCounter),
      type: 'install',
      status: 'queued',
      packages,
      logs: [],
      logEntries: [],
      createdAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    };

    this.activeJob = job;
    void this.runInstall(job);
    return job;
  }

  startRemove(packageNames: string[]): JobState {
    if (this.isRunning()) {
      throw new Error('A job is already running');
    }

    const job: JobState = {
      id: String(++this.jobCounter),
      type: 'remove',
      status: 'queued',
      packages: packageNames.map((name) => ({ name, version: '' })),
      logs: [],
      logEntries: [],
      createdAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    };

    this.activeJob = job;
    void this.runRemove(job);
    return job;
  }

  cancelJob(id: string): JobState | null {
    if (!this.activeJob || this.activeJob.id !== id) {
      return null;
    }

    const job = this.activeJob;
    if (job.status === 'succeeded' || job.status === 'failed') {
      return job;
    }

    if (!job.cancelRequestedAt) {
      job.cancelRequestedAt = new Date().toISOString();
      this.appendLog(job, 'Cancellation requested by user.');
    }

    if (job.status === 'queued') {
      this.failJob(job, new Error('Cancelled by user'));
      return job;
    }

    this.terminateActiveProcess(job, 'Cancellation requested by user.');
    return job;
  }

  private appendLog(job: JobState, message: string, source: RuntimeLibraryLogSource = 'system'): void {
    const createdAt = new Date().toISOString();
    job.logs.push(message);
    job.logEntries.push({ message, createdAt, source });
    job.lastProgressAt = createdAt;
    this.emit('log', job.id, message, createdAt, source);
  }

  private setStatus(job: JobState, status: JobStatus): void {
    job.status = status;
    const createdAt = new Date().toISOString();
    if (!job.startedAt && status !== 'queued') {
      job.startedAt = createdAt;
    }
    job.lastProgressAt = createdAt;
    this.emit('status', job.id, status, createdAt, job.cancelRequestedAt ?? null);
  }

  private async runInstall(job: JobState): Promise<void> {
    try {
      ensureDirectories();
      this.setStatus(job, 'running');
      this.appendLog(job, '--- Starting install job ---');

      const manifest = readManifest();
      const candidatePackages = { ...manifest.packages };
      for (const pkg of job.packages) {
        candidatePackages[pkg.name] = {
          name: pkg.name,
          version: pkg.version,
          installedAt: new Date().toISOString(),
        };
        this.appendLog(job, `Adding: ${pkg.name}@${pkg.version}`);
      }

      this.throwIfCancelled(job);
      await this.buildAndPromote(job, manifest, candidatePackages);
    } catch (err) {
      this.failJob(job, err);
    }
  }

  private async runRemove(job: JobState): Promise<void> {
    try {
      ensureDirectories();
      this.setStatus(job, 'running');
      this.appendLog(job, '--- Starting remove job ---');

      const manifest = readManifest();
      const candidatePackages = { ...manifest.packages };
      for (const pkg of job.packages) {
        if (!(pkg.name in candidatePackages)) {
          this.appendLog(job, `Warning: ${pkg.name} is not installed, skipping`);
          continue;
        }

        delete candidatePackages[pkg.name];
        this.appendLog(job, `Removing: ${pkg.name}`);
      }

      this.throwIfCancelled(job);
      await this.buildAndPromote(job, manifest, candidatePackages);
    } catch (err) {
      this.failJob(job, err);
    }
  }

  private async buildAndPromote(
    job: JobState,
    manifest: RuntimeLibraryManifest,
    candidatePackages: Record<string, RuntimeLibraryEntry>,
  ): Promise<void> {
    const staging = stagingDir();

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    const dependencies: Record<string, string> = {};
    for (const entry of Object.values(candidatePackages)) {
      dependencies[entry.name] = entry.version;
    }

    const packageJson = {
      name: 'rivet-runtime-libraries',
      private: true,
      version: '1.0.0',
      description: 'Managed runtime libraries for Rivet code nodes',
      dependencies,
    };

    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');
    this.appendLog(job, `Generated package.json with ${Object.keys(dependencies).length} dependencies`);
    this.throwIfCancelled(job);

    if (Object.keys(dependencies).length === 0) {
      this.appendLog(job, 'No dependencies to install, creating empty release');
      fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
    } else {
      this.appendLog(job, 'Running npm install...');
      const exitCode = await this.npmInstall(job, staging);
      if (exitCode !== 0) {
        this.throwIfCancelled(job);
        this.failJob(job, new Error(`npm install failed with exit code ${exitCode}`));
        return;
      }

      this.throwIfCancelled(job);
      this.appendLog(job, 'npm install completed successfully');
    }

    this.setStatus(job, 'validating');
    this.appendLog(job, 'Validating installed packages...');
    this.throwIfCancelled(job);
    const validationErrors = this.validateCandidate(staging, candidatePackages);
    if (validationErrors.length > 0) {
      for (const err of validationErrors) {
        this.appendLog(job, `Validation error: ${err}`);
      }

      this.failJob(job, new Error(`Validation failed: ${validationErrors.join('; ')}`));
      return;
    }

    this.appendLog(job, 'Validation passed');

    this.setStatus(job, 'activating');
    this.appendLog(job, 'Promoting staged libraries...');
    this.throwIfCancelled(job);
    this.activateStaging(staging);

    manifest.packages = candidatePackages;
    writeManifest(manifest);

    this.appendLog(job, 'Current runtime libraries are now active');
    this.appendLog(job, '--- Job completed successfully ---');
    this.setStatus(job, 'succeeded');
    job.finishedAt = new Date().toISOString();
  }

  private npmInstall(job: JobState, cwd: string): Promise<number> {
    return new Promise((resolve) => {
      const child = execStreaming('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd,
        env: buildChildProcessEnv(),
        timeoutMs: 300_000,
      });
      this.activeProcess = child.process;

      const cleanup = () => {
        if (this.activeProcess === child.process) {
          this.activeProcess = null;
        }
      };

      child.on('data', (source, data) => {
        const lines = data.split('\n').filter((line) => line.trim());
        for (const line of lines) {
          this.appendLog(job, line, source);
        }
      });

      child.on('exit', (code) => {
        cleanup();
        resolve(code);
      });

      child.on('error', (err) => {
        cleanup();
        this.appendLog(job, `Process error: ${err.message}`);
        resolve(1);
      });
    });
  }

  private validateCandidate(candidateDir: string, packages: Record<string, RuntimeLibraryEntry>): string[] {
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
    } catch (err) {
      errors.push(`createRequire failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return errors;
  }

  private activateStaging(staging: string): void {
    const current = currentDir();
    const backup = `${current}.previous`;

    fs.rmSync(backup, { recursive: true, force: true });

    try {
      if (fs.existsSync(current)) {
        fs.renameSync(current, backup);
      }

      fs.renameSync(staging, current);
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(current) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, current);
        } catch {
          // ignore restoration failure and surface the original error
        }
      }

      throw error;
    }
  }

  private failJob(job: JobState, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.terminateActiveProcess(job, message);
    job.error = message;
    job.finishedAt = new Date().toISOString();
    this.appendLog(job, `ERROR: ${message}`);
    this.appendLog(job, '--- Job failed ---');
    this.setStatus(job, 'failed');

    try {
      fs.rmSync(stagingDir(), { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  private throwIfCancelled(job: JobState): void {
    if (job.cancelRequestedAt) {
      throw new Error('Cancelled by user');
    }
  }

  private terminateActiveProcess(job: JobState, reason: string): void {
    const child = this.activeProcess;
    if (!child || child.killed) {
      this.activeProcess = null;
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      this.activeProcess = null;
      return;
    }

    const killTimer = setTimeout(() => {
      if (this.activeProcess !== child || child.exitCode != null) {
        return;
      }

      this.appendLog(job, `Process did not exit after SIGTERM (${reason}); forcing shutdown.`);
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore late kill failures
      }
    }, 5_000);
    killTimer.unref?.();

    child.once('exit', () => {
      clearTimeout(killTimer);
      if (this.activeProcess === child) {
        this.activeProcess = null;
      }
    });
  }
}

export const jobRunner = new JobRunner();
