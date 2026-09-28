import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectLocalMetadataTransition, recoverLocalMetadataToLegacy } from '../local-metadata/recover-legacy.js';
import type { LocalMetadataTransition } from '../local-metadata/transition-journal.js';

export function ownerModulePath(): string {
  const bundled = '/opt/rivet/local-metadata-owner-lease.mjs';
  if (existsSync(bundled)) return bundled;
  // Locate the owning repository from either src/ or compiled dist/. Never
  // depend on the shell's working directory or import a similarly named npm package.
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(cursor, 'deploy/studio-server/images/api/local-metadata-owner-lease.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Supported local metadata owner module was not found.');
    cursor = parent;
  }
}

function printStatus(result: LocalMetadataTransition): void {
  console.log(
    JSON.stringify({
      phase: result.phase,
      backend: result.backend,
      paused: result.paused,
      canReturnToLegacy: result.canReturnToLegacy,
      revision: result.revision,
      generationId: result.generation?.id ?? null,
    }),
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === '--help') {
    console.log(
      'Usage: recover-local-metadata --status\n       recover-local-metadata <expected-revision> <expected-generation-id>\nRequires RIVET_LOCAL_METADATA_CONTROL_ROOT; return-to-legacy also requires all four source-root environment variables. Stop the whole combined backend container first, not only its supervisor. Recovery remains paused; this command never resumes writes.',
    );
    return;
  }
  const statusOnly = process.argv.length === 3 && process.argv[2] === '--status';
  if (!statusOnly && process.argv.length !== 4)
    throw new Error('Use --help for the offline local metadata recovery command.');
  const required = (key: string) => {
    const value = process.env[key];
    if (!value || !path.isAbsolute(value)) throw new Error(`${key} must be an explicit absolute path.`);
    return value;
  };
  const controlRoot = required('RIVET_LOCAL_METADATA_CONTROL_ROOT');
  const { acquireLocalMetadataOwnerLease } = (await import(pathToFileURL(ownerModulePath()).href)) as {
    acquireLocalMetadataOwnerLease(root: string, options: { requireExisting: boolean }): { release(): void };
  };
  const withExclusiveOwner = async <T>(operation: () => Promise<T>): Promise<T> => {
    const lease = acquireLocalMetadataOwnerLease(controlRoot, { requireExisting: true });
    try {
      return await operation();
    } finally {
      lease.release();
    }
  };
  if (statusOnly) {
    printStatus(await inspectLocalMetadataTransition({ controlRoot, withExclusiveOwner }));
    return;
  }
  const revision = process.argv[2]!;
  if (!/^[1-9][0-9]*$/.test(revision)) throw new Error('Expected revision must be a positive integer.');
  const result = await recoverLocalMetadataToLegacy({
    controlRoot,
    source: {
      workflows: required('RIVET_WORKFLOWS_ROOT'),
      recordings: required('RIVET_WORKFLOW_RECORDINGS_ROOT'),
      appData: required('RIVET_APP_DATA_ROOT'),
      runtimeLibraries: required('RIVET_RUNTIME_LIBRARIES_ROOT'),
    },
    expectedRevision: Number(revision),
    expectedGenerationId: process.argv[3]!,
    withExclusiveOwner,
  });
  printStatus(result);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => {
    // Recovery errors can contain filesystem or parser details. Keep the CLI
    // redacted; inspect preserved control/source data with the operator tools.
    console.error(
      'Local metadata recovery refused or failed. Source and candidate were not deleted; writes were not resumed. Check the owner lease, expected revision/generation, retained source proof and journal integrity.',
    );
    process.exitCode = 1;
  });
}
