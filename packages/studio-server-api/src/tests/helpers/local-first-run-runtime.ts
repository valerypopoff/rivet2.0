import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  initializeLocalMetadataServing,
  assertLocalMetadataWritesAllowed,
} from '../../local-metadata/runtime-control.js';
import { getLocalMetadataServingSelection } from '../../local-metadata/serving-selection.js';
import { initializeLocalRuntimeLibraryAuthority } from '../../local-metadata/runtime-library-authority.js';
import {
  initializeAppSettingsRepositories,
  disposeAppSettingsRepositories,
  getAppSettingsBackendKind,
} from '../../app-settings/settings-repository.js';
import {
  initializeWorkflowStorage,
  disposeWorkflowStorage,
  createWorkflowProjectItemWithBackend,
  loadHostedProject,
} from '../../routes/workflows/storage-backend.js';
import { getLocalUpgradeSetupStatus } from '../../local-metadata/operator-service.js';
import { DatabaseSync } from 'node:sqlite';
import { createProxySettingsSnapshot } from '../../proxy-settings-snapshot.js';
import { readPublicRouteSettingsSync, writePublicRouteSettings } from '../../public-route-settings.js';
import { writeEnvironmentVariableSettings, readEnvironmentVariableValue } from '../../environment-variable-settings.js';

let disposeLibraries: (() => void) | undefined;
try {
  await initializeLocalMetadataServing();
  await initializeAppSettingsRepositories();
  disposeLibraries = await initializeLocalRuntimeLibraryAuthority(
    getLocalMetadataServingSelection()!,
    assertLocalMetadataWritesAllowed,
  );
  await initializeWorkflowStorage();
  assertLocalMetadataWritesAllowed();
  assert.equal(getAppSettingsBackendKind(), 'sqlite');
  assert.equal(getLocalUpgradeSetupStatus().liveSqlite, true);
  const selection = getLocalMetadataServingSelection()!;
  if (process.argv[2] === 'write') {
    const previousProxyRevision = createProxySettingsSnapshot().revision;
    await createWorkflowProjectItemWithBackend('', 'First project');
    await writeEnvironmentVariableSettings({
      variables: [{ id: 'first-run-fixture', name: 'FIRST_RUN_FIXTURE', value: '42', browserAccess: false }],
    });
    await writePublicRouteSettings({
      ...readPublicRouteSettingsSync(),
      publishedWorkflowsBasePath: 'first-run-workflows',
    });
    assert.notEqual(createProxySettingsSnapshot().revision, previousProxyRevision);
  }
  assert.equal(createProxySettingsSnapshot().backend, 'sqlite');
  assert.equal(createProxySettingsSnapshot().publishedWorkflowsBasePath, '/first-run-workflows');
  assert.equal(await readEnvironmentVariableValue('first-run-fixture'), '42');
  const project = await loadHostedProject(path.join(process.env.RIVET_WORKFLOWS_ROOT!, 'First project.rivet-project'));
  assert.ok(project);
  assert.ok((await fs.readdir(selection.artifactRoot)).length > 0);
  const settings = new DatabaseSync(selection.settingsDatabasePath, { readOnly: true });
  try {
    const record = settings
      .prepare("SELECT value_json FROM app_settings WHERE setting_key = 'environment variable'")
      .get() as { value_json: string };
    assert.equal(JSON.parse(record.value_json).variables[0].value, '42');
  } finally {
    settings.close();
  }
} finally {
  disposeLibraries?.();
  await disposeWorkflowStorage();
  await disposeAppSettingsRepositories();
}
