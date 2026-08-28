import { useMemo } from 'react';

import { trustedHostSettingsResource } from '../appSettingsApi';
import { createTrustedHostForm, parseDelimitedListText, type TrustedHostSettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: TrustedHostSettingsForm = { trustedHostsText: '' };

export function useTrustedHostsForm(enabled: boolean) {
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: trustedHostSettingsResource,
    toForm: createTrustedHostForm,
  });
  const trustedHosts = useMemo(
    () => parseDelimitedListText(resource.form.trustedHostsText),
    [resource.form.trustedHostsText],
  );
  const normalizedText = trustedHosts.join('\n');

  return {
    ...resource,
    changed: normalizedText !== resource.baseline.trustedHostsText,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert: () => resource.resetForm(),
    save: () => resource.save({ trustedHosts }),
  };
}
