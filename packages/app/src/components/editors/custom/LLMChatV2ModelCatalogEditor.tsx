import Button from '@atlaskit/button';
import { Field } from '@atlaskit/form';
import Select from '@atlaskit/select';
import TextField from '@atlaskit/textfield';
import Portal from '@atlaskit/portal';
import {
  coerceTypeOptional,
  type ChartNode,
  type CustomEditorDefinition,
  type NodeGraph,
  type PortId,
} from '@valerypopoff/rivet2-core';
import { css } from '@emotion/react';
import { useAtomValue } from 'jotai';
import { type FC, useEffect, useState } from 'react';
import clsx from 'clsx';
import { settingsState } from '../../../state/settings.js';
import {
  lastRunDataState,
  resolvedGraphSelectionState,
  type GraphRunRecord,
  type GraphRunSelection,
  type ProcessDataForNode,
} from '../../../state/dataFlow.js';
import { useDependsOnPlugins } from '../../../hooks/useDependsOnPlugins.js';
import { fillMissingSettingsFromEnvironmentVariables } from '../../../utils/tauri.js';
import { tryRestoreStoredDataValue } from '../../../utils/executionDataStorage.js';
import { getStaticInputApiKey } from '../../../utils/chatV2ModelCatalogInputKey.js';
import {
  getChatV2DiscoveredModelOptionsWithStatus,
  invalidateChatV2DiscoveredModelOptions,
} from '../../../utils/chatV2ModelCatalog.js';
import {
  getChatV2ModelRefreshStatus,
  type ChatV2ModelRefreshStatus,
} from '../../../utils/chatV2ModelCatalogStatus.js';
import {
  forgetRefreshedModelOptions,
  getVisibleModelOptions,
  rememberRefreshedModelOptions,
  type ModelOption,
} from './llmChatV2ModelCatalogOptions.js';
import { type SharedEditorProps } from '../SharedEditorProps';
import PlugIcon from '../../../assets/icons/plug-icon.svg?react';
import { Tooltip } from '../../Tooltip';
import { useDataRefs, useEnvironmentProvider, type DataRefReader } from '../../../providers/ProvidersContext.js';
import { getSelectedProcessData } from '../../../state/selectors/executionSelectors.js';
import { graphState } from '../../../state/graph.js';

const styles = css`
  display: flex;
  flex-direction: column;
  gap: 8px;

  .model-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
  }

  .model-row.is-custom-provider {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .model-input-toggle {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--grey-darkish);
    border-radius: 16px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 8px;
    }
    background: var(--grey-darkest);
    color: var(--foreground-muted);
    cursor: pointer;
    transition:
      background-color 0.15s ease-out,
      border-color 0.15s ease-out,
      color 0.15s ease-out;
  }

  .model-input-toggle:focus {
    outline: none;
  }

  .model-input-toggle:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }

  .model-input-toggle:hover:not(:disabled) {
    background: var(--grey-darkerish);
    color: var(--grey-light);
  }

  .model-input-toggle.is-active {
    background: var(--primary);
    border-color: var(--primary);
    color: white;
  }

  .model-input-toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .model-input-toggle svg {
    width: 18px;
    height: 18px;
  }

  .refresh-models {
    margin-left: 18px;
    white-space: nowrap;
  }

  .banner {
    width: 100%;
    padding: 10px 12px;
    border-radius: 12px;
    corner-shape: squircle;
    @supports not (corner-shape: squircle) {
      border-radius: 6px;
    }
    font-size: var(--ui-font-size-sm);
    line-height: 1.4;
    border: 1px solid transparent;
  }

  .banner.warning {
    background: rgba(255, 196, 0, 0.12);
    border-color: rgba(255, 196, 0, 0.35);
    color: var(--foreground);
  }

  .banner.success {
    background: rgba(54, 179, 126, 0.12);
    border-color: rgba(54, 179, 126, 0.35);
    color: var(--foreground);
  }
`;

type Props = SharedEditorProps & {
  editor: CustomEditorDefinition<ChartNode>;
};

type ProviderName = 'openai' | 'anthropic' | 'google' | 'custom';

const modelCatalogRefreshStatus = new Map<string, ChatV2ModelRefreshStatus>();

function getProvider(data: unknown): ProviderName {
  return ((data as { provider?: ProviderName }).provider ?? 'openai') as ProviderName;
}

function getStatusKey(nodeId: string, provider: ProviderName, apiKeySource: string): string {
  return `${nodeId}:${provider}:${apiKeySource}`;
}

function getApiKeySource(data: unknown): string {
  return (data as { apiKeySource?: string }).apiKeySource ?? 'environment';
}

function getLatestInputApiKey(options: {
  graph: NodeGraph | undefined;
  nodeId: ChartNode['id'];
  lastRun: ProcessDataForNode[] | undefined;
  graphSelectionOptions: {
    graphRuns?: GraphRunRecord[];
    selectedGraphRun?: GraphRunSelection;
  };
  dataRefs: DataRefReader;
}): string | undefined {
  const staticApiKey = getStaticInputApiKey({
    graph: options.graph,
    nodeId: options.nodeId,
  });
  if (staticApiKey) {
    return staticApiKey;
  }

  const storedApiKey = getSelectedProcessData(options.lastRun, 'latest', options.graphSelectionOptions)?.data
    .inputData?.['apiKey' as PortId];

  return coerceTypeOptional(tryRestoreStoredDataValue(storedApiKey, options.dataRefs), 'string')?.trim();
}

export const LLMChatV2ModelCatalogEditor: FC<Props> = ({
  node,
  onChange,
  isReadonly,
  isDisabled,
  editor,
  onRefreshEditors,
}) => {
  const settings = useAtomValue(settingsState);
  const graph = useAtomValue(graphState);
  const lastRun = useAtomValue(lastRunDataState(node.id));
  const graphSelectionOptions = useAtomValue(resolvedGraphSelectionState);
  const plugins = useDependsOnPlugins();
  const dataRefs = useDataRefs();
  const environmentProvider = useEnvironmentProvider();
  const provider = getProvider(node.data);
  const data = node.data as Record<string, unknown>;
  const apiKeySource = getApiKeySource(data);
  const statusKey = getStatusKey(node.id, provider, apiKeySource);
  const [status, setStatus] = useState<ChatV2ModelRefreshStatus>(() => modelCatalogRefreshStatus.get(statusKey));
  const [menuPortalTarget, setMenuPortalTarget] = useState<HTMLDivElement | null>(null);
  const modelOptions = getVisibleModelOptions({
    editor,
    currentModel: data.model,
    optionsKey: statusKey,
  });
  const selectedValue = modelOptions.find((option) => option.value === data.model);
  const isUsingModelInput = Boolean(data.useModelInput);
  const isControlDisabled = isReadonly || isDisabled;
  const isCustomProvider = provider === 'custom';

  const updateStatus = (nextStatus: ChatV2ModelRefreshStatus) => {
    if (nextStatus == null) {
      modelCatalogRefreshStatus.delete(statusKey);
    } else {
      modelCatalogRefreshStatus.set(statusKey, nextStatus);
    }
    setStatus(nextStatus);
  };

  useEffect(() => {
    setStatus(modelCatalogRefreshStatus.get(statusKey));
  }, [statusKey]);

  const handleRefresh = async () => {
    forgetRefreshedModelOptions(statusKey);
    updateStatus({
      tone: 'warning',
      message: 'Refreshing model list...',
    });

    try {
      const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
        environmentProvider,
      });
      const apiKey =
        apiKeySource === 'input'
          ? getLatestInputApiKey({ graph, nodeId: node.id, lastRun, graphSelectionOptions, dataRefs })
          : undefined;

      if (apiKeySource === 'input' && !apiKey) {
        throw new Error(
          'API Key input is required when API key source is Input port. Connect API Key to a static Text node or another resolvable source before re-fetching the model list.',
        );
      }

      const context = { settings: resolvedSettings, plugins, apiKey };

      invalidateChatV2DiscoveredModelOptions(provider, context);
      const result = await getChatV2DiscoveredModelOptionsWithStatus(provider, context);
      rememberRefreshedModelOptions(statusKey, result.options);
      updateStatus(getChatV2ModelRefreshStatus(provider, result, resolvedSettings, plugins, apiKey));
      onRefreshEditors?.();
    } catch (error) {
      updateStatus({
        tone: 'warning',
        message: error instanceof Error ? error.message : 'Failed to refresh model list.',
      });
    }
  };

  return (
    <div css={styles}>
      <Field name="model" label={editor.label} isDisabled={isControlDisabled}>
        {({ fieldProps }) => (
          <div className={clsx('model-row', isCustomProvider && 'is-custom-provider')}>
            {isCustomProvider ? (
              <TextField
                {...fieldProps}
                value={(data.model as string | undefined) ?? ''}
                isReadOnly={isReadonly}
                isDisabled={isDisabled}
                autoComplete="off"
                spellCheck={false}
                placeholder="model-id"
                onChange={(event) =>
                  onChange({
                    ...node,
                    data: {
                      ...data,
                      model: (event.target as HTMLInputElement).value,
                    },
                  })
                }
              />
            ) : (
              <Select
                {...fieldProps}
                options={modelOptions}
                value={selectedValue}
                menuPortalTarget={menuPortalTarget}
                onChange={(selected) =>
                  selected &&
                  onChange({
                    ...node,
                    data: {
                      ...data,
                      model: selected.value,
                    },
                  })
                }
              />
            )}
            <Tooltip content="Use an input port for Model">
              <button
                type="button"
                className={clsx('model-input-toggle', isUsingModelInput && 'is-active')}
                aria-label="Use an input port for Model"
                aria-pressed={isUsingModelInput}
                disabled={isControlDisabled}
                onClick={() =>
                  onChange({
                    ...node,
                    data: {
                      ...data,
                      useModelInput: !isUsingModelInput,
                    },
                  })
                }
              >
                <PlugIcon />
              </button>
            </Tooltip>
            {!isCustomProvider ? (
              <Button
                className="refresh-models"
                appearance="primary"
                onClick={() => void handleRefresh()}
                isDisabled={isControlDisabled}
              >
                Re-fetch Model List
              </Button>
            ) : null}
            <Portal>
              <div ref={setMenuPortalTarget} />
            </Portal>
          </div>
        )}
      </Field>
      {status ? <div className={`banner ${status.tone}`}>{status.message}</div> : null}
    </div>
  );
};
