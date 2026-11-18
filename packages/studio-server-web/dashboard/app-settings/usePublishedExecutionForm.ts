import { publishedExecutionSettingsResource, type PublishedExecutionSettings } from '../appSettingsApi';
import { useSettingsFormResource } from './useSettingsFormResource';

type Form = { value: string; useDefault: boolean; settings: PublishedExecutionSettings | null };
const defaultForm: Form = { value: '', useDefault: true, settings: null };
const toForm = (settings: PublishedExecutionSettings): Form => ({
  value: String(settings.effectiveMaxActiveRunsPerPod ?? ''),
  useDefault: settings.maxActiveRunsPerPod === null,
  settings,
});

export function usePublishedExecutionForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: publishedExecutionSettingsResource,
    toForm,
  });
  const value = Number(resource.form.value.trim());
  const valid =
    /^\d+$/.test(resource.form.value.trim()) && Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
  return {
    ...resource,
    changed:
      resource.form.value !== resource.baseline.value || resource.form.useDefault !== resource.baseline.useDefault,
    valid,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving || !resource.form.settings?.editable,
    save: () => (valid ? resource.save({ maxActiveRunsPerPod: resource.form.useDefault ? null : value }) : undefined),
  };
}
