import { workflowEndpointAuthSettingsResource } from '../appSettingsApi';
import type { WorkflowEndpointAuthSettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: WorkflowEndpointAuthSettingsForm = { requireBearerAuth: true };

export function useWorkflowEndpointAuthForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: workflowEndpointAuthSettingsResource,
    toForm: (settings) => ({ requireBearerAuth: settings.requireBearerAuth }),
  });

  return {
    ...resource,
    changed: resource.form.requireBearerAuth !== resource.baseline.requireBearerAuth,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert: () => resource.resetForm(),
    save: () => resource.save({ requireBearerAuth: resource.form.requireBearerAuth }),
  };
}
