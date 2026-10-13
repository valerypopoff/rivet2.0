import { deploymentStorageSettingsResource } from '../appSettingsApi';
import { createDeploymentStorageForm, type DeploymentStorageSettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: DeploymentStorageSettingsForm = {
  storageMode: 'filesystem',
  databaseSslMode: 'disable',
  databaseConnectionStringConfigured: false,
  objectStorageBucket: '',
  objectStorageEndpoint: '',
  objectStorageRegion: 'us-east-1',
  objectStoragePrefix: 'workflows/',
  objectStorageForcePathStyle: false,
  deploymentManaged: false,
  storageAccessKeyId: '',
  storageAccessKeyConfigured: false,
};

export function useDeploymentStorageForm(enabled: boolean) {
  const { form, loaded, loading, error } = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: deploymentStorageSettingsResource,
    toForm: createDeploymentStorageForm,
  });
  // Storage is deployment-owned. Do not expose mutation or save actions to the panel.
  return { form, loaded, loading, error };
}
