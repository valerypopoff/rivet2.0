import { type FC, useCallback, useSyncExternalStore } from 'react';
import { useAtom } from 'jotai';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { css } from '@emotion/react';
import { settingsState } from '../../../state/settings.js';
import { fields } from '../settingsPageStyles.js';
import { FieldHelperMessage } from '../../FieldHelperMessage.js';
import {
  aiAssistCustomModelState,
  aiAssistCustomProviderBaseURLState,
  selectedAssistModelState,
} from '../../../state/ai.js';
import {
  aiAssistProviderOptions,
  createAiAssistModelOptions,
  getAiAssistModelOptionForProvider,
  getAiAssistModelOptionsForProvider,
  getAiAssistProviderFromModel,
  getAiAssistProviderOption,
  getDefaultAiAssistModelForProvider,
  includeCurrentAiAssistModelOption,
  type AiAssistModelSelectorValue,
  type AiAssistProvider,
} from '../../../utils/aiAssistModelSettings.js';
import { useDependsOnPlugins } from '../../../hooks/useDependsOnPlugins.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../../../utils/tauri.js';
import { useEnvironmentProvider } from '../../../providers/ProvidersContext.js';
import { chatV2ModelCatalogService } from '../../../utils/chatV2ModelCatalogService.js';

const llmSettingsStyles = css`
  .ai-assist-model-control {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .ai-assist-model-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
  }

  .ai-assist-refresh-models {
    white-space: nowrap;
  }

  .ai-assist-refresh-status {
    width: 100%;
    padding: 10px 12px;
    border-radius: 12px;
    corner-shape: squircle;
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    border: 1px solid transparent;
  }

  @supports not (corner-shape: squircle) {
    .ai-assist-refresh-status {
      border-radius: 6px;
    }
  }

  .ai-assist-refresh-status.warning {
    background: rgba(255, 196, 0, 0.12);
    border-color: rgba(255, 196, 0, 0.35);
    color: var(--foreground);
  }

  .ai-assist-refresh-status.success {
    background: rgba(54, 179, 126, 0.12);
    border-color: rgba(54, 179, 126, 0.35);
    color: var(--foreground);
  }
`;

type RefreshableAiAssistProvider = Exclude<AiAssistProvider, 'custom'>;

function isRefreshableAiAssistProvider(provider: AiAssistProvider): provider is RefreshableAiAssistProvider {
  return provider !== 'custom';
}

export const LlmSettingsPage: FC = () => {
  const [settings, setSettings] = useAtom(settingsState);
  const [selectedAssistModel, setSelectedAssistModel] = useAtom(selectedAssistModelState);
  const [customAssistProviderBaseURL, setCustomAssistProviderBaseURL] = useAtom(aiAssistCustomProviderBaseURLState);
  const [customAssistModel, setCustomAssistModel] = useAtom(aiAssistCustomModelState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const selectedAssistProvider = getAiAssistProviderFromModel(selectedAssistModel);
  const modelCatalogSessionKey = `ai-assist:${selectedAssistProvider}`;
  const subscribeToModelCatalog = useCallback(
    (listener: () => void) => chatV2ModelCatalogService.subscribe(modelCatalogSessionKey, listener),
    [modelCatalogSessionKey],
  );
  const getModelCatalogSnapshot = useCallback(
    () => chatV2ModelCatalogService.getSnapshot(modelCatalogSessionKey),
    [modelCatalogSessionKey],
  );
  const modelCatalogSession = useSyncExternalStore(
    subscribeToModelCatalog,
    getModelCatalogSnapshot,
    getModelCatalogSnapshot,
  );
  const selectedAssistProviderOption = getAiAssistProviderOption(selectedAssistProvider);
  const assistModelOptions = includeCurrentAiAssistModelOption(
    isRefreshableAiAssistProvider(selectedAssistProvider)
      ? modelCatalogSession.options
        ? createAiAssistModelOptions(selectedAssistProvider, modelCatalogSession.options)
        : getAiAssistModelOptionsForProvider(selectedAssistProvider)
      : getAiAssistModelOptionsForProvider(selectedAssistProvider),
    selectedAssistModel,
    selectedAssistProvider,
  );
  const selectedAssistModelOption = getAiAssistModelOptionForProvider(
    selectedAssistModel,
    selectedAssistProvider,
    assistModelOptions,
  );

  const refreshAiAssistModelOptions = async () => {
    if (!isRefreshableAiAssistProvider(selectedAssistProvider)) {
      return;
    }

    const provider = selectedAssistProvider;
    try {
      const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
        environmentProvider,
      });
      await chatV2ModelCatalogService.refresh({
        sessionKey: modelCatalogSessionKey,
        provider,
        context: { settings: resolvedSettings, plugins },
      });
    } catch (error) {
      chatV2ModelCatalogService.setError(modelCatalogSessionKey, error);
    }
  };

  return (
    <div css={[fields, llmSettingsStyles]}>
      <section className="settings-section">
        <h2 className="settings-section-heading">Generate using AI</h2>
        <FieldHelperMessage>
          Choose the provider and model used by the &quot;Generate using AI&quot; feature.
        </FieldHelperMessage>
        <div className="settings-section-fields">
          <Field name="ai-assist-provider" label="Drafting provider">
            {() => (
              <Select
                options={aiAssistProviderOptions}
                value={selectedAssistProviderOption}
                onChange={(option) => {
                  if (option) {
                    setSelectedAssistModel(getDefaultAiAssistModelForProvider(option.value as AiAssistProvider));
                  }
                }}
              />
            )}
          </Field>
          {selectedAssistProvider !== 'custom' && (
            <Field name="ai-assist-model" label="Drafting model">
              {() => (
                <div className="ai-assist-model-control">
                  <div className="ai-assist-model-row">
                    <Select
                      options={assistModelOptions}
                      value={selectedAssistModelOption}
                      onChange={(option) => {
                        if (option) {
                          setSelectedAssistModel(option.value as AiAssistModelSelectorValue);
                        }
                      }}
                    />
                    <Button
                      className="ai-assist-refresh-models"
                      appearance="primary"
                      onClick={() => void refreshAiAssistModelOptions()}
                    >
                      Re-fetch Model List
                    </Button>
                  </div>
                  {modelCatalogSession.status ? (
                    <div className={`ai-assist-refresh-status ${modelCatalogSession.status.tone}`}>
                      {modelCatalogSession.status.message}
                    </div>
                  ) : null}
                </div>
              )}
            </Field>
          )}
          {selectedAssistProvider === 'custom' && (
            <>
              <Field name="ai-assist-custom-provider-base-url" label="Custom provider API URL">
                {() => (
                  <>
                    <FieldHelperMessage>
                      OpenAI-compatible base URL for Generate using AI, for example https://api.cerebras.ai/v1. Rivet
                      will use this with the custom provider API key below.
                    </FieldHelperMessage>
                    <TextField
                      value={customAssistProviderBaseURL}
                      onChange={(event) =>
                        setCustomAssistProviderBaseURL((event.target as HTMLInputElement).value)
                      }
                    />
                  </>
                )}
              </Field>
              <Field name="ai-assist-custom-model" label="Custom provider model">
                {() => (
                  <TextField
                    value={customAssistModel}
                    onChange={(event) => setCustomAssistModel((event.target as HTMLInputElement).value)}
                  />
                )}
              </Field>
            </>
          )}
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-section-heading">LLM credentials</h2>
        <FieldHelperMessage>
          These credentials can be used by LLM-powered nodes and the Rivet editor. They are not saved into project YAML.
          They may also be set with corresponding environment variables such as OPENAI_API_KEY, ANTHROPIC_API_KEY,
          GOOGLE_GENERATIVE_AI_API_KEY, CUSTOM_PROVIDER_API_KEY, and OPENAI_ORG_ID, or passed as matching runtime keys
          when running projects programmatically.
        </FieldHelperMessage>
        <div className="settings-section-fields">
          <Field name="openai-api-key" label="OpenAI API Key">
            {() => (
              <TextField
                type="password"
                value={settings.openAiApiKey || settings.openAiKey || ''}
                onChange={(event) =>
                  setSettings((state) => ({
                    ...state,
                    openAiApiKey: (event.target as HTMLInputElement).value,
                    openAiKey: (event.target as HTMLInputElement).value,
                  }))
                }
              />
            )}
          </Field>
          <Field name="anthropic-api-key" label="Anthropic API Key">
            {() => (
              <TextField
                type="password"
                value={settings.anthropicApiKey ?? ''}
                onChange={(event) =>
                  setSettings((state) => ({ ...state, anthropicApiKey: (event.target as HTMLInputElement).value }))
                }
              />
            )}
          </Field>
          <Field name="google-api-key" label="Google API Key">
            {() => (
              <TextField
                type="password"
                value={settings.googleApiKey ?? ''}
                onChange={(event) =>
                  setSettings((state) => ({ ...state, googleApiKey: (event.target as HTMLInputElement).value }))
                }
              />
            )}
          </Field>
          <Field name="custom-provider-api-key" label="Custom provider API Key">
            {() => (
              <TextField
                type="password"
                value={settings.customAiApiKey ?? ''}
                onChange={(event) =>
                  setSettings((state) => ({ ...state, customAiApiKey: (event.target as HTMLInputElement).value }))
                }
              />
            )}
          </Field>
          <Field name="openai-organization" label="OpenAI Organization">
            {() => (
              <TextField
                value={settings.openAiOrganization ?? ''}
                onChange={(event) =>
                  setSettings((state) => ({
                    ...state,
                    openAiOrganization: (event.target as HTMLInputElement).value,
                  }))
                }
              />
            )}
          </Field>
        </div>
      </section>
    </div>
  );
};
