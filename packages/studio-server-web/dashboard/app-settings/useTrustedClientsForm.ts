import { useEffect, useMemo, useState } from 'react';

import { readCurrentTrustedClient, trustedClientSettingsResource } from '../appSettingsApi';
import { createTrustedClientForm, parseDelimitedListText, type TrustedClientSettingsForm } from './model';
import { useSettingsFormResource } from './useSettingsFormResource';

const defaultForm: TrustedClientSettingsForm = { trustedClientsText: '' };

export function useTrustedClientsForm(enabled: boolean) {
  const [clientAddress, setClientAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readCurrentTrustedClient().then((result) => {
      if (!cancelled) setClientAddress(result.clientAddress);
    }).catch(() => { if (!cancelled) setClientAddress(null); });
    return () => { cancelled = true; };
  }, [enabled]);
  const resource = useSettingsFormResource({
    defaultForm,
    enabled,
    resource: trustedClientSettingsResource,
    toForm: createTrustedClientForm,
  });
  const trustedClients = useMemo(
    () => parseDelimitedListText(resource.form.trustedClientsText),
    [resource.form.trustedClientsText],
  );
  const normalizedText = trustedClients.join('\n');

  return {
    ...resource,
    clientAddress,
    changed: !!resource.baseline.policyError || normalizedText !== resource.baseline.trustedClientsText,
    controlsDisabled: !resource.loaded || resource.loading || resource.saving,
    revert: () => resource.resetForm(),
    save: () => resource.save({ trustedClients }),
  };
}
