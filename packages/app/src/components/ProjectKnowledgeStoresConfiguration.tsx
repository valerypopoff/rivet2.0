import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import Select from '@atlaskit/select';
import Textfield from '@atlaskit/textfield';
import { css } from '@emotion/react';
import {
  getKnowledgeStoreProvider,
  getKnowledgeStoreProviders,
  normalizeKnowledgeConnectionId,
  readKnowledgeStoreConnectionCredentialsDraft,
  removeKnowledgeStoreConnectionCredentials,
  writeKnowledgeStoreConnectionCredentials,
  type KnowledgeStoreConnectionDefinition,
  type KnowledgeStoreProviderConfigField,
  type Settings,
} from '@valerypopoff/rivet2-core';
import { useAtom } from 'jotai';
import EyeIcon from 'majesticons/line/eye-line.svg?react';
import EyeOffIcon from 'majesticons/line/eye-off-line.svg?react';
import { nanoid } from 'nanoid/non-secure';
import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
import { settingsState } from '../state/settings.js';
import { AppModalHeader } from './AppModalHeader.js';
import {
  createExistingKnowledgeStoreDraft,
  createNewKnowledgeStoreDraft,
  duplicateKnowledgeStoreDraft,
  normalizeProjectKnowledgeStoreDraftFields,
  switchNewKnowledgeStoreDraftProvider,
  type ProjectKnowledgeStoreDraft,
} from './projectKnowledgeStoreDraft.js';

const styles = css`
  .knowledge-store-heading,
  .knowledge-store-row,
  .knowledge-store-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .knowledge-store-heading,
  .knowledge-store-row {
    justify-content: space-between;
  }

  .knowledge-store-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 8px 0;
  }

  .knowledge-store-row {
    border: 1px solid var(--grey-dark);
    border-radius: 4px;
    padding: 8px;
  }

  .knowledge-store-provider,
  .knowledge-store-help {
    opacity: 0.72;
    font-size: 12px;
  }

  .knowledge-store-empty {
    margin: 8px 0;
    opacity: 0.72;
  }
`;

const modalStyles = css`
  display: flex;
  flex-direction: column;
  gap: 16px;

  .knowledge-store-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .knowledge-store-field label {
    font-weight: 600;
  }

  .knowledge-store-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .knowledge-store-secret-toggle {
    align-self: center;
    margin-inline-end: 2px;
  }

  .knowledge-store-field input[type='password']::-ms-reveal,
  .knowledge-store-field input[type='password']::-ms-clear {
    display: none;
  }
`;

export const ProjectKnowledgeStoresConfiguration: FC = () => {
  const [project, setProject] = useAtom(projectState);
  const [settings, setSettings] = useAtom(settingsState);
  const [editing, setEditing] = useState<ProjectKnowledgeStoreDraft>();
  const providers = getKnowledgeStoreProviders();
  const connections = Object.entries(project.metadata.knowledgeStores ?? {}).sort(([, left], [, right]) =>
    left.displayName.localeCompare(right.displayName),
  );

  const openNew = () => {
    const provider = providers[0];
    if (!provider) {
      toast.error('Enable a plugin that provides a knowledge store before adding a connection.');
      return;
    }
    setEditing(createNewKnowledgeStoreDraft(nanoid(), provider));
  };

  const openExisting = (connectionId: string, definition: KnowledgeStoreConnectionDefinition) => {
    const provider = getKnowledgeStoreProvider(definition.provider);
    setEditing(
      createExistingKnowledgeStoreDraft(
        connectionId,
        definition,
        provider ? readKnowledgeStoreConnectionCredentialsDraft(settings, provider, connectionId) : {},
      ),
    );
  };

  const duplicate = (definition: KnowledgeStoreConnectionDefinition) => {
    setEditing(
      duplicateKnowledgeStoreDraft(
        nanoid(),
        definition,
        connections.map(([, value]) => value.displayName),
      ),
    );
  };

  const remove = (connectionId: string, definition: KnowledgeStoreConnectionDefinition) => {
    const usageCount = Object.values(project.graphs).reduce(
      (count, graph) =>
        count +
        graph.nodes.filter((node) => {
          const data = node.data as Record<string, unknown> | undefined;
          return (
            node.type === 'knowledgeSource' &&
            data?.useConnectionIdInput !== true &&
            data?.connectionId === connectionId
          );
        }).length,
      0,
    );
    const usageWarning = usageCount
      ? ` ${usageCount} Knowledge Source node${usageCount === 1 ? '' : 's'} currently reference it.`
      : '';
    if (!window.confirm(`Remove knowledge store "${definition.displayName}"?${usageWarning}`)) return;

    setProject((current) => {
      const knowledgeStores = { ...(current.metadata.knowledgeStores ?? {}) };
      delete knowledgeStores[connectionId];
      return { ...current, metadata: { ...current.metadata, knowledgeStores } };
    });
    setSettings((current) => removeKnowledgeStoreConnectionCredentials(current, definition.provider, connectionId));
  };

  return (
    <div css={styles}>
      <div className="knowledge-store-heading">
        <strong>Knowledge stores</strong>
        <Button appearance="default" onClick={openNew}>
          Add Store
        </Button>
      </div>
      <div className="knowledge-store-help">
        Connections are saved with the project. Credentials stay in local Rivet settings or are supplied by the runtime
        host.
      </div>
      {connections.length === 0 ? (
        <div className="knowledge-store-empty">No knowledge stores configured.</div>
      ) : (
        <div className="knowledge-store-list">
          {connections.map(([connectionId, definition]) => (
            <div className="knowledge-store-row" key={connectionId}>
              <div>
                <div>{definition.displayName}</div>
                <div className="knowledge-store-provider">
                  {getKnowledgeStoreProvider(definition.provider)?.displayName ?? definition.provider} · {connectionId}
                </div>
              </div>
              <div className="knowledge-store-actions">
                <Button appearance="subtle" onClick={() => openExisting(connectionId, definition)}>
                  Edit
                </Button>
                <Button appearance="subtle" onClick={() => duplicate(definition)}>
                  Duplicate
                </Button>
                <Button appearance="subtle" onClick={() => remove(connectionId, definition)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ModalTransition>
        {editing && (
          <KnowledgeStoreModal
            editing={editing}
            providers={providers}
            settings={settings}
            onCancel={() => setEditing(undefined)}
            onSave={(next) => {
              const connectionId = normalizeKnowledgeConnectionId(next.connectionId);
              if (connectionId !== next.connectionId) {
                throw new Error('Knowledge store connection IDs cannot be padded.');
              }
              const provider = getKnowledgeStoreProvider(next.providerId);
              if (!provider) throw new Error(`Knowledge store provider "${next.providerId}" is not installed.`);
              const displayName = next.displayName.trim();
              if (!displayName) throw new Error('Knowledge store name cannot be empty.');
              if (
                connections.some(
                  ([id, value]) =>
                    id !== next.connectionId &&
                    value.displayName.toLocaleLowerCase() === displayName.toLocaleLowerCase(),
                )
              ) {
                throw new Error(`A knowledge store named "${displayName}" already exists.`);
              }
              const { config, credentials } = normalizeProjectKnowledgeStoreDraftFields(next, provider);
              setProject((current) => ({
                ...current,
                metadata: {
                  ...current.metadata,
                  knowledgeStores: {
                    ...(current.metadata.knowledgeStores ?? {}),
                    [connectionId]: {
                      displayName,
                      provider: next.providerId,
                      pluginId: provider.pluginId ?? provider.id,
                      config,
                    },
                  },
                },
              }));
              setSettings((current) =>
                writeKnowledgeStoreConnectionCredentials(current, next.providerId, connectionId, credentials),
              );
              setEditing(undefined);
            }}
          />
        )}
      </ModalTransition>
    </div>
  );
};

const KnowledgeStoreModal: FC<{
  editing: ProjectKnowledgeStoreDraft;
  providers: ReturnType<typeof getKnowledgeStoreProviders>;
  settings: Settings;
  onCancel(): void;
  onSave(editing: ProjectKnowledgeStoreDraft): void;
}> = ({ editing: initial, providers, settings, onCancel, onSave }) => {
  const [editing, setEditing] = useState(initial);
  const [testing, setTesting] = useState(false);
  const testAbortController = useRef<AbortController>();
  const provider = getKnowledgeStoreProvider(editing.providerId);
  const providerOptions = providers.map((item) => ({ label: item.displayName, value: item.id }));

  useEffect(() => () => testAbortController.current?.abort(), []);

  const testConnection = async () => {
    if (!provider?.testConnection) {
      toast.info('This provider does not expose a connection test.');
      return;
    }
    testAbortController.current?.abort();
    const abortController = new AbortController();
    testAbortController.current = abortController;
    setTesting(true);
    try {
      const { config, credentials } = normalizeProjectKnowledgeStoreDraftFields(editing, provider);
      const definition: KnowledgeStoreConnectionDefinition = {
        displayName: editing.displayName.trim() || 'Unsaved connection',
        provider: editing.providerId,
        pluginId: provider.pluginId ?? provider.id,
        config,
      };
      await provider.testConnection(definition, credentials, abortController.signal, { settings });
      if (!abortController.signal.aborted) toast.success('Knowledge store connection succeeded.');
    } catch (error) {
      if (!abortController.signal.aborted) toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (testAbortController.current === abortController) {
        testAbortController.current = undefined;
        setTesting(false);
      }
    }
  };

  const cancel = () => {
    testAbortController.current?.abort();
    onCancel();
  };

  return (
    <Modal onClose={cancel} width="medium">
      <AppModalHeader title={editing.isNew ? 'Add Knowledge Store' : 'Edit Knowledge Store'} />
      <ModalBody>
        <div css={modalStyles} className="knowledge-store-form">
          <ConfigField label="Name">
            <Textfield
              value={editing.displayName}
              onChange={(event) => setEditing({ ...editing, displayName: event.currentTarget.value })}
            />
          </ConfigField>
          <ConfigField label="Provider">
            <Select
              options={providerOptions}
              value={providerOptions.find((option) => option.value === editing.providerId) ?? null}
              isDisabled={!editing.isNew}
              onChange={(selected) => {
                if (!selected) return;
                const nextProvider = getKnowledgeStoreProvider(selected.value);
                if (nextProvider) setEditing(switchNewKnowledgeStoreDraftProvider(editing, nextProvider));
              }}
            />
          </ConfigField>
          {provider?.connectionConfigSpec.map((field) => (
            <ProviderField
              key={field.key}
              field={field}
              value={readOwnProperty(editing.config, field.key)}
              onChange={(value) => setEditing({ ...editing, config: { ...editing.config, [field.key]: value } })}
            />
          ))}
          {(provider?.credentialConfigSpec?.length ?? 0) > 0 && <strong>Credentials</strong>}
          {provider?.credentialConfigSpec?.map((field) => (
            <ProviderField
              key={`credential:${editing.providerId}:${field.key}`}
              field={field}
              value={readOwnProperty(editing.credentials, field.key) ?? ''}
              onChange={(value) =>
                setEditing({
                  ...editing,
                  credentials: { ...editing.credentials, [field.key]: String(value ?? '') },
                })
              }
            />
          ))}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button appearance="subtle" isDisabled={testing} onClick={() => void testConnection()}>
          {testing ? 'Testing...' : 'Test Connection'}
        </Button>
        <Button appearance="subtle" onClick={cancel}>
          Cancel
        </Button>
        <Button
          appearance="primary"
          onClick={() => {
            try {
              onSave(editing);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          Save
        </Button>
      </ModalFooter>
    </Modal>
  );
};

const ConfigField: FC<{ label: string; children: ReactNode; description?: string }> = ({
  label,
  children,
  description,
}) => (
  <div className="knowledge-store-field">
    <label>{label}</label>
    {children}
    {description && <div className="knowledge-store-help">{description}</div>}
  </div>
);

const ProviderField: FC<{
  field: KnowledgeStoreProviderConfigField;
  value: unknown;
  onChange(value: unknown): void;
}> = ({ field, value, onChange }) => {
  const [isSecretVisible, setIsSecretVisible] = useState(false);

  if (field.type === 'boolean') {
    return (
      <ConfigField label={field.label} description={field.description}>
        <label className="knowledge-store-checkbox">
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.currentTarget.checked)} />
          Enabled
        </label>
      </ConfigField>
    );
  }
  if (field.type === 'select') {
    const options = field.options ?? [];
    return (
      <ConfigField label={field.label} description={field.description}>
        <Select
          options={options}
          value={options.find((option) => option.value === value) ?? null}
          onChange={(selected) => onChange(selected?.value ?? '')}
        />
      </ConfigField>
    );
  }
  const isSecret = field.type === 'secret';
  const secretVisibilityLabel = isSecretVisible ? `Hide ${field.label}` : `Show ${field.label}`;

  return (
    <ConfigField label={field.label} description={field.description}>
      <Textfield
        type={isSecret && !isSecretVisible ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        elemAfterInput={
          isSecret ? (
            <Button
              appearance="subtle"
              spacing="compact"
              className="knowledge-store-secret-toggle"
              iconBefore={isSecretVisible ? <EyeOffIcon width={16} height={16} /> : <EyeIcon width={16} height={16} />}
              aria-label={secretVisibilityLabel}
              aria-pressed={isSecretVisible}
              title={secretVisibilityLabel}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setIsSecretVisible((current) => !current)}
            />
          ) : undefined
        }
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          onChange(field.type === 'number' && nextValue !== '' ? Number(nextValue) : nextValue);
        }}
      />
    </ConfigField>
  );
};

function readOwnProperty(value: unknown, key: string): unknown {
  return hasOwnProperty(value, key) ? value[key] : undefined;
}

function hasOwnProperty(value: unknown, key: string): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)
  );
}
