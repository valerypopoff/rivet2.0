import { useMemo } from 'react';

import type { DeploymentStorageSettingsDraft } from '../../../studio-server-shared/app-settings-types';
import { deploymentStorageSettingsResource } from '../appSettingsApi';
import { createDeploymentStorageForm, type DeploymentStorageSettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: DeploymentStorageSettingsForm = {
  storageMode: 'filesystem',
  artifactsHostPath: '../',
  databaseMode: 'local-docker',
  databaseSslMode: 'disable',
  databaseConnectionString: '',
  databaseConnectionStringConfigured: false,
  objectStorageBucket: '',
  objectStorageEndpoint: '',
  objectStorageRegion: 'us-east-1',
  objectStoragePrefix: 'workflows/',
  objectStorageForcePathStyle: false,
  deploymentManaged: false,
  storageAccessKeyId: '',
  storageAccessKey: '',
  storageAccessKeyConfigured: false,
};

export function useDeploymentStorageForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: deploymentStorageSettingsResource,
    toForm: createDeploymentStorageForm,
  });
  const draft = useMemo<DeploymentStorageSettingsDraft>(
    () => ({
      storageMode: resource.form.storageMode,
      databaseMode: resource.form.databaseMode,
      databaseSslMode: resource.form.databaseSslMode,
      databaseConnectionString: resource.form.databaseConnectionString.trim(),
      ...(resource.form.storageMode === 'managed'
        ? {
            objectStorageBucket: resource.form.objectStorageBucket.trim(),
            objectStorageEndpoint: resource.form.objectStorageEndpoint.trim(),
            objectStorageRegion: resource.form.objectStorageRegion.trim(),
            objectStoragePrefix: resource.form.objectStoragePrefix.trim(),
            objectStorageForcePathStyle: resource.form.objectStorageForcePathStyle,
          }
        : {}),
      storageAccessKeyId: resource.form.storageAccessKeyId.trim(),
      storageAccessKey: resource.form.storageAccessKey.trim(),
    }),
    [resource.form],
  );
  const changed =
    resource.form.storageMode !== resource.baseline.storageMode ||
    resource.form.databaseMode !== resource.baseline.databaseMode ||
    resource.form.databaseSslMode !== resource.baseline.databaseSslMode ||
    draft.databaseConnectionString !== '' ||
    resource.form.objectStorageBucket.trim() !== resource.baseline.objectStorageBucket ||
    resource.form.objectStorageEndpoint.trim() !== resource.baseline.objectStorageEndpoint ||
    resource.form.objectStorageRegion.trim() !== resource.baseline.objectStorageRegion ||
    resource.form.objectStoragePrefix.trim() !== resource.baseline.objectStoragePrefix ||
    resource.form.objectStorageForcePathStyle !== resource.baseline.objectStorageForcePathStyle ||
    draft.storageAccessKeyId !== resource.baseline.storageAccessKeyId ||
    draft.storageAccessKey !== '';

  return {
    ...resource,
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving || resource.form.deploymentManaged,
    revert: () => resource.resetForm(),
    save: () => resource.save(draft),
  };
}
