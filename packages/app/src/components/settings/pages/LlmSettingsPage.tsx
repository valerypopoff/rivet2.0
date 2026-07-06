import { type FC, useEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import Select from '@atlaskit/select';
import { DEFAULT_CHAT_NODE_TIMEOUT } from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import { entries } from '../../../utils/typeSafety';
import { KeyValuePairs } from '../../editors/KeyValuePairEditor.js';
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
  type AiAssistModelOption,
  type AiAssistModelSelectorValue,
  type AiAssistProvider,
} from '../../../utils/aiAssistModelSettings.js';
import { useDependsOnPlugins } from '../../../hooks/useDependsOnPlugins.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../../../utils/tauri.js';
import { useEnvironmentProvider } from '../../../providers/ProvidersContext.js';
import {
  getChatV2DiscoveredModelOptionsWithStatus,
  invalidateChatV2DiscoveredModelOptions,
} from '../../../utils/chatV2ModelCatalog.js';
import {
  getChatV2ModelRefreshStatus,
  type ChatV2ModelRefreshStatus,
} from '../../../utils/chatV2ModelCatalogStatus.js';

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
    min-height: 40px;
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

const aiAssistRefreshedModelOptions = new Map<RefreshableAiAssistProvider, AiAssistModelOption[]>();
const aiAssistModelCatalogRefreshStatus = new Map<RefreshableAiAssistProvider, ChatV2ModelRefreshStatus>();

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
  const chatNodeHeadersPairs = entries(settings.chatNodeHeaders ?? {}).map(([key, value]) => ({ key, value }));
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>(chatNodeHeadersPairs);
  const selectedAssistProvider = getAiAssistProviderFromModel(selectedAssistModel);
  const selectedAssistProviderRef = useRef(selectedAssistProvider);
  const selectedAssistProviderOption = getAiAssistProviderOption(selectedAssistProvider);
  const [assistModelRefreshStatus, setAssistModelRefreshStatus] = useState<ChatV2ModelRefreshStatus>(() =>
    isRefreshableAiAssistProvider(selectedAssistProvider)
      ? aiAssistModelCatalogRefreshStatus.get(selectedAssistProvider)
      : undefined,
  );
  const assistModelOptions = includeCurrentAiAssistModelOption(
    isRefreshableAiAssistProvider(selectedAssistProvider)
      ? (aiAssistRefreshedModelOptions.get(selectedAssistProvider) ?? getAiAssistModelOptionsForProvider(selectedAssistProvider))
      : getAiAssistModelOptionsForProvider(selectedAssistProvider),
    selectedAssistModel,
    selectedAssistProvider,
  );
  const selectedAssistModelOption = getAiAssistModelOptionForProvider(
    selectedAssistModel,
    selectedAssistProvider,
    assistModelOptions,
  );

  useEffect(() => {
    selectedAssistProviderRef.current = selectedAssistProvider;
    setAssistModelRefreshStatus(
      isRefreshableAiAssistProvider(selectedAssistProvider)
        ? aiAssistModelCatalogRefreshStatus.get(selectedAssistProvider)
        : undefined,
    );
  }, [selectedAssistProvider]);

  const onSetHeaders = (newHeaders: { key: string; value: string }[]) => {
    setHeaders(newHeaders);
    setSettings((state) => ({
      ...state,
      chatNodeHeaders: Object.fromEntries(newHeaders.map(({ key, value }) => [key, value])),
    }));
  };

  const configureAzure = () => {
    setSettings((state) => ({
      ...state,
      openAiEndpoint:
        'https://{your-resource-name}.openai.azure.com/openai/deployments/{deployment-id}/chat/completions?api-version=2023-05-15',
      chatNodeHeaders: {
        'api-key': '',
      },
    }));

    setHeaders([{ key: 'api-key', value: '' }]);
  };

  const configureLmStudio = () => {
    setSettings((state) => ({
      ...state,
      openAiEndpoint: 'http://localhost:1234/v1/chat/completions',
    }));
  };

  const updateAiAssistModelRefreshStatus = (
    provider: RefreshableAiAssistProvider,
    nextStatus: ChatV2ModelRefreshStatus,
  ) => {
    if (nextStatus == null) {
      aiAssistModelCatalogRefreshStatus.delete(provider);
    } else {
      aiAssistModelCatalogRefreshStatus.set(provider, nextStatus);
    }

    if (provider === selectedAssistProviderRef.current) {
      setAssistModelRefreshStatus(nextStatus);
    }
  };

  const refreshAiAssistModelOptions = async () => {
    if (!isRefreshableAiAssistProvider(selectedAssistProvider)) {
      return;
    }

    const provider = selectedAssistProvider;
    aiAssistRefreshedModelOptions.delete(provider);
    updateAiAssistModelRefreshStatus(provider, {
      tone: 'warning',
      message: 'Refreshing model list...',
    });

    try {
      const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
        environmentProvider,
      });
      const context = { settings: resolvedSettings, plugins };

      invalidateChatV2DiscoveredModelOptions(provider, context);
      const result = await getChatV2DiscoveredModelOptionsWithStatus(provider, context);
      aiAssistRefreshedModelOptions.set(provider, createAiAssistModelOptions(provider, result.options));
      updateAiAssistModelRefreshStatus(provider, getChatV2ModelRefreshStatus(provider, result, resolvedSettings, plugins));
    } catch (error) {
      updateAiAssistModelRefreshStatus(provider, {
        tone: 'warning',
        message: error instanceof Error ? error.message : 'Failed to refresh model list.',
      });
    }
  };

  return (
    <div css={[fields, llmSettingsStyles]}>
      <FieldHelperMessage>
        These app settings are used by editor runs, model-list refreshes, and node-settings Generate using AI. They are
        not saved into project YAML; Node package, CLI, and server runs need keys passed through runtime options or
        environment variables.
      </FieldHelperMessage>
      <section className="settings-section">
        <h2 className="settings-section-heading">Generate using AI</h2>
        <FieldHelperMessage>
          Choose the provider and model used by the node-settings Generate using AI modal for drafting content and code.
          The modal only shows this choice; change it here when you want to use a different drafting model.
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
                  {assistModelRefreshStatus ? (
                    <div className={`ai-assist-refresh-status ${assistModelRefreshStatus.tone}`}>
                      {assistModelRefreshStatus.message}
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
      <Field name="openai-api-key" label="OpenAI API Key">
        {() => (
          <>
            <FieldHelperMessage>
              Used by OpenAI LLM Chat nodes in Configured key mode, OpenAI model-list refresh, Generate using AI when it
              uses an OpenAI drafting model, and legacy Chat, Get Embedding, and OpenAI plugin nodes. You may also set
              the OPENAI_API_KEY environment variable.
            </FieldHelperMessage>
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
          </>
        )}
      </Field>
      <Field name="anthropic-api-key" label="Anthropic API Key">
        {() => (
          <>
            <FieldHelperMessage>
              Used by Anthropic LLM Chat nodes in Configured key mode, Anthropic model-list refresh, Generate using AI
              when it uses an Anthropic drafting model, and legacy Anthropic plugin nodes when no plugin-specific key is
              set. You may also set the ANTHROPIC_API_KEY environment variable.
            </FieldHelperMessage>
            <TextField
              type="password"
              value={settings.anthropicApiKey ?? ''}
              onChange={(event) =>
                setSettings((state) => ({ ...state, anthropicApiKey: (event.target as HTMLInputElement).value }))
              }
            />
          </>
        )}
      </Field>
      <Field name="google-api-key" label="Google API Key">
        {() => (
          <>
            <FieldHelperMessage>
              Used by Google LLM Chat nodes in Configured key mode, Google model-list refresh, and legacy Google plugin
              nodes when no plugin-specific key is set. You may also set the GOOGLE_GENERATIVE_AI_API_KEY environment
              variable.
            </FieldHelperMessage>
            <TextField
              type="password"
              value={settings.googleApiKey ?? ''}
              onChange={(event) =>
                setSettings((state) => ({ ...state, googleApiKey: (event.target as HTMLInputElement).value }))
              }
            />
          </>
        )}
      </Field>
      <Field name="custom-provider-api-key" label="Custom provider API Key">
        {() => (
          <>
            <FieldHelperMessage>
              Used by LLM Chat custom providers in Configured key mode and by Generate using AI when its drafting
              provider is Custom provider. It is not used by built-in OpenAI, Anthropic, or Google providers. You may also set
              CUSTOM_AI_API_KEY, CUSTOM_PROVIDER_API_KEY, or the node-specific API key environment variable.
            </FieldHelperMessage>
            <TextField
              type="password"
              value={settings.customAiApiKey ?? ''}
              onChange={(event) =>
                setSettings((state) => ({ ...state, customAiApiKey: (event.target as HTMLInputElement).value }))
              }
            />
          </>
        )}
      </Field>
      <Field name="openai-organization" label="OpenAI Organization">
        {() => (
          <>
            <FieldHelperMessage>
              You may also set the OPENAI_ORG_ID environment variable. This is only required if you are a member of a
              shared organization.
            </FieldHelperMessage>
            <TextField
              value={settings.openAiOrganization ?? ''}
              onChange={(event) =>
                setSettings((state) => ({
                  ...state,
                  openAiOrganization: (event.target as HTMLInputElement).value,
                }))
              }
            />
          </>
        )}
      </Field>
      <Field name="timeout" label="LLM timeout (ms)">
        {() => (
          <>
            <FieldHelperMessage>
              The timeout for the initial response for a chat node. If you are using local models, you may need to
              increase this. Chat nodes are automatically retried if they time out. If you notice a chat node hanging
              for a long time, you may want to increase this.
            </FieldHelperMessage>
            <TextField
              type="number"
              value={settings.chatNodeTimeout ?? DEFAULT_CHAT_NODE_TIMEOUT}
              onChange={(event) => {
                if ((event.target as HTMLInputElement).valueAsNumber > 0) {
                  setSettings((state) => ({
                    ...state,
                    chatNodeTimeout: (event.target as HTMLInputElement).valueAsNumber,
                  }));
                }
              }}
            />
          </>
        )}
      </Field>
      {!settings.openAiEndpoint && (
        <Field name="autoConfiguration" label="Auto Configuration">
          {() => (
            <div className="auto-configurations">
              <div className="configure-azure">
                <FieldHelperMessage>
                  You can click this button to set up a configuration for Azure OpenAI. You will have to fill in
                  placeholder fields in the OpenAI Endpoint, and fill in your API key header.
                </FieldHelperMessage>
                <Button appearance="primary" onClick={configureAzure}>
                  Configure For Azure OpenAI
                </Button>
              </div>
              <div className="configure-lmstudio">
                <FieldHelperMessage>
                  You can click this button to set up a configuration for LM Studio. You will also need to either use
                  the Node executor, or enable CORS in your LM Studio settings.
                </FieldHelperMessage>
                <Button appearance="primary" onClick={configureLmStudio}>
                  Configure For LM Studio
                </Button>
              </div>
            </div>
          )}
        </Field>
      )}
      <Field name="openai-endpoint" label="OpenAI-compatible endpoint">
        {() => (
          <>
            <FieldHelperMessage>
              Default endpoint to use for OpenAI-compatible chat nodes. Leave blank to use OpenAI itself. You may also
              set the OPENAI_ENDPOINT environment variable.
            </FieldHelperMessage>
            <TextField
              value={settings.openAiEndpoint ?? ''}
              onChange={(event) =>
                setSettings((state) => ({ ...state, openAiEndpoint: (event.target as HTMLInputElement).value }))
              }
            />
          </>
        )}
      </Field>
      <KeyValuePairs
        label="Chat node headers"
        helperMessage="Headers to send with each OpenAI-compatible chat request. You can use this for alternative APIs such as Azure OpenAI."
        name="chatNodeHeaders"
        keyValuePairs={headers}
        isValuesSecret
        onAddPair={() => onSetHeaders([...headers, { key: '', value: '' }])}
        onDeletePair={(index) => onSetHeaders(headers.filter((_, headerIndex) => headerIndex !== index))}
        onPairChange={(index, keyOrValue, value) => {
          const newHeaders = [...headers];
          newHeaders[index]![keyOrValue] = value;
          onSetHeaders(newHeaders);
        }}
      />
    </div>
  );
};
