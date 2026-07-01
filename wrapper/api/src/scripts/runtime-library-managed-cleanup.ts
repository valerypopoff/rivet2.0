import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config as loadDotEnv } from 'dotenv';

import {
  auditManagedRuntimeLibrariesState,
  managedRuntimeLibrariesCleanupPolicy,
  pruneManagedRuntimeLibrariesState,
  type ManagedRuntimeLibrariesAuditSnapshot,
} from '../runtime-libraries/managed/cleanup.js';
import { getRuntimeLibrariesBackendMode } from '../runtime-libraries/config.js';

function loadNearestEnvFile(startDir: string): void {
  let currentDir = path.resolve(startDir);

  while (true) {
    for (const fileName of ['.env', '.env.dev']) {
      const candidate = path.join(currentDir, fileName);
      if (existsSync(candidate)) {
        loadDotEnv({ path: candidate });
        return;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }

    currentDir = parentDir;
  }
}

function findRepoRoot(startDir: string): string {
  let currentDir = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
        if (packageJson.name === 'rivet-studio-server') {
          return currentDir;
        }
      } catch {
        // ignore unreadable package.json and continue upward
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return startDir;
    }

    currentDir = parentDir;
  }
}

function formatCountByStatus(snapshot: ManagedRuntimeLibrariesAuditSnapshot): string {
  return Object.entries(snapshot.totalJobCountByStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
}

function toSnapshotFolderName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function writeSnapshotJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function printAuditSummary(snapshot: ManagedRuntimeLibrariesAuditSnapshot): void {
  console.log(`[runtime-libraries:managed] Active release: ${snapshot.activeReleaseId ?? 'none'}`);
  console.log(`[runtime-libraries:managed] Releases: ${snapshot.totalReleaseCount}`);
  console.log(`[runtime-libraries:managed] Jobs: ${snapshot.totalJobCount} (${formatCountByStatus(snapshot)})`);
  console.log(`[runtime-libraries:managed] Objects under runtime-libraries/: ${snapshot.totalObjectCount} (${snapshot.totalObjectBytes} bytes)`);
  console.log(`[runtime-libraries:managed] Missing-artifact releases: ${snapshot.releaseRowsMissingArtifacts.length}`);
  console.log(`[runtime-libraries:managed] Orphaned artifacts: ${snapshot.orphanedArtifacts.length}`);
  console.log(
    `[runtime-libraries:managed] Prune candidates: ${snapshot.prunePlan.pruneCandidateReleaseIds.length} releases, ` +
    `${snapshot.prunePlan.pruneCandidateJobIds.length} jobs, ` +
    `${snapshot.prunePlan.pruneCandidateOrphanedArtifactKeys.length} orphaned artifacts.`,
  );
}

function printPlannedDeletes(snapshot: ManagedRuntimeLibrariesAuditSnapshot): void {
  const releaseLines = snapshot.releases
    .filter((release) => release.pruneCandidate)
    .map((release) => `  release ${release.releaseId} -> ${release.artifactBlobKey}`);
  const jobLines = snapshot.jobs
    .filter((job) => job.pruneCandidate)
    .map((job) => `  job ${job.jobId} (${job.status})`);
  const artifactLines = snapshot.objects
    .filter((entry) => entry.pruneCandidate)
    .map((entry) => `  object ${entry.key}`);

  if (releaseLines.length > 0) {
    console.log('[runtime-libraries:managed] Releases to delete:');
    for (const line of releaseLines) {
      console.log(line);
    }
  }

  if (jobLines.length > 0) {
    console.log('[runtime-libraries:managed] Jobs to delete:');
    for (const line of jobLines) {
      console.log(line);
    }
  }

  if (artifactLines.length > 0) {
    console.log('[runtime-libraries:managed] Orphaned artifacts to delete:');
    for (const line of artifactLines) {
      console.log(line);
    }
  }
}

async function runAudit(snapshotDir: string): Promise<void> {
  const snapshot = await auditManagedRuntimeLibrariesState();
  const auditPath = path.join(snapshotDir, 'audit.json');
  await writeSnapshotJson(auditPath, {
    snapshot,
    policy: managedRuntimeLibrariesCleanupPolicy,
  });
  printAuditSummary(snapshot);
  console.log(`[runtime-libraries:managed] Wrote audit snapshot to ${auditPath}`);
}

async function runPrune(snapshotDir: string, apply: boolean): Promise<void> {
  const preflight = await auditManagedRuntimeLibrariesState();
  const preflightPath = path.join(snapshotDir, 'pre-prune-audit.json');
  const planPath = path.join(snapshotDir, 'prune-plan.json');

  await writeSnapshotJson(preflightPath, {
    snapshot: preflight,
    policy: managedRuntimeLibrariesCleanupPolicy,
  });
  await writeSnapshotJson(planPath, {
    generatedAt: new Date().toISOString(),
    apply,
    prunePlan: preflight.prunePlan,
    missingArtifactReleaseRows: preflight.releaseRowsMissingArtifacts,
  });

  printAuditSummary(preflight);
  printPlannedDeletes(preflight);

  if (!apply) {
    console.log('[runtime-libraries:managed] Dry run only. Re-run with --apply to delete the listed items.');
    console.log(`[runtime-libraries:managed] Wrote pre-prune snapshot to ${preflightPath}`);
    console.log(`[runtime-libraries:managed] Wrote prune plan to ${planPath}`);
    return;
  }

  const result = await pruneManagedRuntimeLibrariesState({ apply: true });
  const postPrunePath = path.join(snapshotDir, 'post-prune-audit.json');

  await writeSnapshotJson(postPrunePath, {
    snapshot: result.after,
    deletedReleaseCount: result.deletedReleaseCount,
    deletedJobCount: result.deletedJobCount,
    deletedObjectCount: result.deletedObjectCount,
    policy: managedRuntimeLibrariesCleanupPolicy,
  });

  console.log(
    `[runtime-libraries:managed] Deleted ${result.deletedReleaseCount} release row(s), ` +
    `${result.deletedJobCount} job row(s), and ${result.deletedObjectCount} object(s).`,
  );
  printAuditSummary(result.after);
  console.log(`[runtime-libraries:managed] Wrote post-prune snapshot to ${postPrunePath}`);
}

async function main(): Promise<void> {
  loadNearestEnvFile(process.cwd());

  const command = process.argv[2]?.trim().toLowerCase() || 'audit';
  const apply = process.argv.includes('--apply');

  if (getRuntimeLibrariesBackendMode() !== 'managed') {
    throw new Error('This command only works when Settings -> Storage uses Object storage.');
  }

  if (!['audit', 'prune'].includes(command)) {
    throw new Error('Usage: tsx src/scripts/runtime-library-managed-cleanup.ts <audit|prune> [--apply]');
  }

  const repoRoot = findRepoRoot(process.cwd());
  const snapshotDir = path.join(
    repoRoot,
    'artifacts',
    'runtime-library-cleanup',
    toSnapshotFolderName(),
  );

  if (command === 'audit') {
    await runAudit(snapshotDir);
    return;
  }

  await runPrune(snapshotDir, apply);
}

main().catch((error) => {
  console.error(`[runtime-libraries:managed] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
