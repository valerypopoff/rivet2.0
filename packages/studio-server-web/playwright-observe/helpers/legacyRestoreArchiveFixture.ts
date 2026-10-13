// Generate on Linux, as a server-generated backup would be. Windows directory
// modes are not portable to Linux; do not weaken the original archive verifier.
export const fixtureScript = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const api = '/app/packages/studio-server-api/dist/studio-server-api/src';
const { createBrowserBackupArchive, browserBackupDirectory } = await import(api + '/local-metadata/browser-backup.js');
const { fingerprintVmMigrationSource } = await import(api + '/scripts/vm-migration-source-manifest.js');
const { createWorkflowPublicationStateHash } = await import(api + '/routes/workflows/publication.js');
const { collectSourceWorkflows } = await import(api + '/local-metadata/filesystem-workflow-source.js');
const fixture = JSON.parse(await fs.readFile('/dev/stdin', 'utf8'));
const root = await fs.mkdtemp('/var/tmp/rivet-kubernetes-ui-backup-');
try {
  // The pod's fsGroup volume can setgid newly created directories. Fixture-only
  // roots must have ordinary modes, as required by the production backup format.
  await fs.chmod(root, 0o700);
  const source = {};
  for (const domain of ['workflows', 'recordings', 'appData', 'runtimeLibraries']) {
    source[domain] = path.join(root, domain);
    await fs.mkdir(source[domain]);
  }
  const projectFile = path.join(source.workflows, 'local-restore-fixture.rivet-project');
  await fs.writeFile(projectFile, fixture.contents);
  const id = randomUUID();
  const snapshotId = randomUUID();
  const createdAt = new Date().toISOString();
  const stateHash = await createWorkflowPublicationStateHash(projectFile, 'local-restore-fixture');
  await fs.mkdir(path.join(source.workflows, '.published'));
  await fs.writeFile(path.join(source.workflows, '.published', snapshotId + '.rivet-project'), fixture.contents);
  await fs.writeFile(path.join(source.workflows, '.published', snapshotId + '.json'), JSON.stringify({
    version: 1, id: snapshotId, projectId: fixture.projectId, projectName: 'Local Kubernetes restore fixture',
    relativePath: 'local-restore-fixture.rivet-project', endpointName: 'local-restore-fixture', publishedAt: createdAt,
    stateHash, isStarred: false, comment: '',
  }));
  await fs.writeFile(projectFile + '.wrapper-settings.json', JSON.stringify({
    publicationVersion: '1', endpointName: 'local-restore-fixture', endpointAccess: 'internal',
    publishedEndpointName: 'local-restore-fixture', publishedSnapshotId: snapshotId, publishedStateHash: stateHash,
    lastPublishedAt: createdAt,
  }));
  await fs.mkdir(path.join(source.appData, 'settings'));
  await fs.writeFile(path.join(source.appData, 'settings', 'environment-variables.json'), JSON.stringify({
    version: 1, variables: [{ id: 'local_restore_ui_fixture', name: 'LOCAL_RESTORE_UI_FIXTURE',
      value: 'restored-in-kubernetes', browserAccess: true }], updatedAt: createdAt,
  }));
  const control = path.join(root, 'control');
  await fs.mkdir(control);
  process.env.RIVET_WORKFLOWS_ROOT=source.workflows;
  if ((await collectSourceWorkflows(source.workflows))[0].endpointStatus !== 'published') {
    throw new Error('Fixture must begin with an unchanged publication.');
  }
  await createBrowserBackupArchive({ control, source, assertFrozen: async () => {}, state: {
    id, revision: 1, pausedAt: createdAt, phase: 'creating', archiveHash: null, bytes: 0, createdAt,
    sourceFingerprint: await fingerprintVmMigrationSource(source),
  } });
  process.stdout.write((await fs.readFile(path.join(browserBackupDirectory(control, id), 'backup.tar.gz'))).toString('base64'));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
`;
