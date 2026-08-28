import {
  disposeAppSettingsRepositories,
  initializeAppSettingsRepositories,
} from '../app-settings/settings-repository.js';
import { projectDeploymentStorageSettings } from '../deployment-storage-settings.js';
import { projectNodeExecutorProxySettings } from '../node-executor-proxy-settings.js';

await initializeAppSettingsRepositories();
try {
  await Promise.all([
    projectDeploymentStorageSettings(),
    projectNodeExecutorProxySettings(),
  ]);
  console.log('[app-settings] Projected managed settings into pod-local runtime files.');
} finally {
  await disposeAppSettingsRepositories();
}