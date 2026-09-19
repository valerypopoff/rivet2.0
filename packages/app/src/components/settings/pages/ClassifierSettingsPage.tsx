import { type FC } from 'react';
import { useAtom } from 'jotai';
import { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { classifierProviders } from '@valerypopoff/rivet2-core';
import { settingsState } from '../../../state/settings.js';
import { FieldHelperMessage } from '../../FieldHelperMessage.js';
import { fields } from '../settingsPageStyles.js';

export const ClassifierSettingsPage: FC = () => {
  const [settings, setSettings] = useAtom(settingsState);

  return (
    <div css={fields}>
      <section className="settings-section">
        <h2 className="settings-section-heading">Classifier credentials</h2>
        <FieldHelperMessage>
          These credentials are used by built-in Classifier nodes. They are not saved into project YAML and may instead be
          supplied through the node&apos;s API Key input or the provider&apos;s documented environment variable.
        </FieldHelperMessage>
        <div className="settings-section-fields">
          {classifierProviders.map((provider) => (
            <Field key={provider.id} name={`classifier-${provider.id}-api-key`} label={`${provider.label} API Key`}>
              {() => (
                <TextField
                  type="password"
                  value={settings.classifierProviders?.[provider.id]?.apiKey ?? ''}
                  onChange={(event) => {
                    const apiKey = event.currentTarget.value;
                    setSettings((current) => ({
                      ...current,
                      classifierProviders: {
                        ...current.classifierProviders,
                        [provider.id]: {
                          ...current.classifierProviders?.[provider.id],
                          apiKey,
                        },
                      },
                    }));
                  }}
                />
              )}
            </Field>
          ))}
        </div>
      </section>
    </div>
  );
};
