import { useMemo } from 'react';

import type { DeploymentStorageSettingsDraft } from '../../../shared/app-settings-types';
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
  storageUrl: '',
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
  const draft = useMemo<DeploymentStorageSettingsDraft>(() => ({
    storageMode: resource.form.storageMode,
    databaseMode: resource.form.databaseMode,
    databaseSslMode: resource.form.databaseSslMode,
    databaseConnectionString: resource.form.databaseConnectionString.trim(),
    storageUrl: resource.form.storageUrl.trim(),
    storageAccessKeyId: resource.form.storageAccessKeyId.trim(),
    storageAccessKey: resource.form.storageAccessKey.trim(),
  }), [resource.form]);
  const changed = (
    resource.form.storageMode !== resource.baseline.storageMode ||
    resource.form.databaseMode !== resource.baseline.databaseMode ||
    resource.form.databaseSslMode !== resource.baseline.databaseSslMode ||
    draft.databaseConnectionString !== '' ||
    draft.storageUrl !== resource.baseline.storageUrl ||
    draft.storageAccessKeyId !== resource.baseline.storageAccessKeyId ||
    draft.storageAccessKey !== ''
  );

  return {
    ...resource,
    changed,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert: () => resource.resetForm(),
    save: () => resource.save(draft),
  };
}
