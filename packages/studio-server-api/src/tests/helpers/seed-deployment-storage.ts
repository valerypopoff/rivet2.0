/** Model an already-provisioned installation, not a live Storage-tab switch.
 * Tests must scope RIVET_APP_DATA_ROOT to their disposable fixture first. */
export async function seedDeploymentStorageSettings(settings: unknown) {
  const { deploymentStorageSettingsRepository, readDeploymentStorageSettings } = await import(
    '../../deployment-storage-settings.js'
  );
  const { toSettingsRecord } = await import('../../app-settings/schema.js');
  await deploymentStorageSettingsRepository.update(() =>
    deploymentStorageSettingsRepository.descriptor.parseStored(toSettingsRecord(settings)),
  );
  return readDeploymentStorageSettings();
}
