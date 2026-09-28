import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownerModulePath } from './recover-local-metadata.js';
import {
  assertLocalControlPaths,
  localMetadataControlRoot,
  localMetadataSourceRoots,
  provisionLocalMetadataControl,
} from '../local-metadata/runtime-control.js';
import { fingerprintVmMigrationSource } from './vm-migration-source-manifest.js';
import { inspectLocalCopyCapacity } from '../local-metadata/copy-capacity.js';

async function main(): Promise<void> {
  if (process.argv[2] === '--help') {
    console.log(
      'Usage: local-metadata-control --provision | --fingerprint | --capacity\nProvision only with the entire combined backend stopped and a new persistent control volume. Fingerprint/capacity inspect four explicit absolute source-root environment paths. Capacity also needs an existing control root and refuses unsafe overlap. Never reset an established transition journal.',
    );
    return;
  }
  if (process.argv.length !== 3 || !['--provision', '--fingerprint', '--capacity'].includes(process.argv[2]!))
    throw new Error('Unsupported local metadata control command.');
  for (const key of [
    'RIVET_WORKFLOWS_ROOT',
    'RIVET_WORKFLOW_RECORDINGS_ROOT',
    'RIVET_APP_DATA_ROOT',
    'RIVET_RUNTIME_LIBRARIES_ROOT',
  ])
    if (!process.env[key] || !path.isAbsolute(process.env[key]!))
      throw new Error('Four explicit absolute source roots are required.');
  const source = localMetadataSourceRoots();
  if (process.argv[2] === '--fingerprint') {
    // Read twice: a moving backup is not certification of a frozen snapshot.
    const fingerprint = await fingerprintVmMigrationSource(source);
    if ((await fingerprintVmMigrationSource(source)) !== fingerprint)
      throw new Error('Backup changed while inspected.');
    console.log(JSON.stringify({ sourceFingerprint: fingerprint }));
    return;
  }
  const root = localMetadataControlRoot();
  await assertLocalControlPaths(root, source);
  if (process.argv[2] === '--capacity') {
    const capacity = await inspectLocalCopyCapacity(source, root);
    console.log(JSON.stringify(capacity));
    if (!capacity.fits) process.exitCode = 2;
    return;
  }
  const { acquireLocalMetadataOwnerLease } = (await import(pathToFileURL(ownerModulePath()).href)) as {
    acquireLocalMetadataOwnerLease(root: string): { release(): void };
  };
  const lease = acquireLocalMetadataOwnerLease(root);
  try {
    await provisionLocalMetadataControl(root, source);
    console.log('Local metadata control provisioned with legacy selected. No source data was changed.');
  } finally {
    lease.release();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main().catch(() => {
    console.error(
      'Local metadata control command refused. No source authority was changed; do not reset an established control volume.',
    );
    process.exitCode = 1;
  });
