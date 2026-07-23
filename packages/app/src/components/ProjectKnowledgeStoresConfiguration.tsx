import Button from '@atlaskit/button';
import Modal, { ModalBody, ModalFooter, ModalTransition } from '@atlaskit/modal-dialog';
import Select from '@atlaskit/select';
import Textfield from '@atlaskit/textfield';
import { css } from '@emotion/react';
import {
  getKnowledgeStoreProvider,
  getKnowledgeStoreProviders,
  normalizeKnowledgeConnectionId,
  type KnowledgeMetadata,
  type KnowledgeStoreConnectionDefinition,
  type KnowledgeStoreProviderConfigField,
  type Settings,
} from '@valerypopoff/rivet2-core';
import { useAtom } from 'jotai';
import { nanoid } from 'nanoid/non-secure';
import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { toast } from 'react-toastify';
import { projectState } from '../state/savedGraphs.js';
import { settingsState } from '../state/settings.js';
import { AppModalHeader } from './AppModalHeader.js';

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
`;

type EditingConnection = {
  connectionId: string;
  displayName: string;
  providerId: string;
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  isNew: boolean;
};

export const ProjectKnowledgeStoresConfiguration: FC = () => {
  const [project, setProject] = useAtom(projectState);
  const [settings, setSettings] = useAtom(settingsState);
  const [editing, setEditing] = useState<EditingConnection>();
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
    setEditing({
      connectionId: nanoid(),
      displayName: '',
      providerId: provider.id,
      config: defaultsFor(provider.connectionConfigSpec),
      credentials: {},
      isNew: true,
    });
  };

  const openExisting = (connectionId: string, definition: KnowledgeStoreConnectionDefinition) => {
    setEditing({
      connectionId,
      displayName: definition.displayName,
      providerId: definition.provider,
      config: { ...definition.config },
      credentials: readConnectionCredentials(readOwnRecord(settings.pluginSettings, definition.provider), connectionId),
      isNew: false,
    });
  };

  const duplicate = (definition: KnowledgeStoreConnectionDefinition) => {
    const usedNames = new Set(connections.map(([, value]) => value.displayName.toLocaleLowerCase()));
    const baseName = `${definition.displayName} copy`;
    let displayName = baseName;
    let suffix = 2;
    while (usedNames.has(displayName.toLocaleLowerCase())) displayName = `${baseName} ${suffix++}`;
    setEditing({
      connectionId: nanoid(),
      displayName,
      providerId: definition.provider,
      config: { ...definition.config },
      credentials: {},
      isNew: true,
    });
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
    setSettings((current) => removeConnectionCredentials(current, definition.provider, connectionId));
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
              const config = normalizeFields(provider.connectionConfigSpec, next.config);
              const credentials = normalizeCredentialFields(provider.credentialConfigSpec ?? [], next.credentials);
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
              setSettings((current) => writeConnectionCredentials(current, next.providerId, connectionId, credentials));
              setEditing(undefined);
            }}
          />
        )}
      </ModalTransition>
    </div>
  );
};

const KnowledgeStoreModal: FC<{
  editing: EditingConnection;
  providers: ReturnType<typeof getKnowledgeStoreProviders>;
  settings: Settings;
  onCancel(): void;
  onSave(editing: EditingConnection): void;
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
      const definition: KnowledgeStoreConnectionDefinition = {
        displayName: editing.displayName.trim() || 'Unsaved connection',
        provider: editing.providerId,
        pluginId: provider.pluginId ?? provider.id,
        config: normalizeFields(provider.connectionConfigSpec, editing.config),
      };
      const credentials = normalizeCredentialFields(provider.credentialConfigSpec ?? [], editing.credentials);
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
                setEditing({
                  ...editing,
                  providerId: selected.value,
                  config: defaultsFor(nextProvider?.connectionConfigSpec ?? []),
                  credentials: {},
                });
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
              key={field.key}
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
  return (
    <ConfigField label={field.label} description={field.description}>
      <Textfield
        type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value == null ? '' : String(value)}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          onChange(field.type === 'number' && nextValue !== '' ? Number(nextValue) : nextValue);
        }}
      />
    </ConfigField>
  );
};

function defaultsFor(fields: KnowledgeStoreProviderConfigField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => [field.key, field.default ?? (field.type === 'boolean' ? false : '')]),
  );
}

function normalizeFields(
  fields: KnowledgeStoreProviderConfigField[],
  values: Record<string, unknown>,
): KnowledgeMetadata {
  const output: KnowledgeMetadata = {};
  for (const field of fields) {
    const value = hasOwnProperty(values, field.key) ? values[field.key] : field.default;
    if (field.required && (value == null || String(value).trim() === '')) {
      throw new Error(`${field.label} is required.`);
    }
    if (value === undefined || value === '') continue;
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${field.label} must be a boolean.`);
      output[field.key] = value;
      continue;
    }
    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${field.label} must be a finite number.`);
      output[field.key] = value;
      continue;
    }
    if (typeof value !== 'string') throw new Error(`${field.label} must be a string.`);
    if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) {
      throw new Error(`${field.label} has an unsupported value.`);
    }
    output[field.key] = value;
  }
  return output;
}

function normalizeCredentialFields(
  fields: NonNullable<ReturnType<typeof getKnowledgeStoreProvider>>['credentialConfigSpec'],
  values: Record<string, string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const field of fields ?? []) {
    const value = hasOwnProperty(values, field.key)
      ? values[field.key]
      : typeof field.default === 'string'
        ? field.default
        : '';
    if (typeof value !== 'string') throw new Error(`${field.label} must be a string.`);
    if (field.required && !value.trim()) throw new Error(`${field.label} is required.`);
    if (value) output[field.key] = value;
  }
  return output;
}

function readConnectionCredentials(
  pluginSettings: Record<string, unknown> | undefined,
  connectionId: string,
): Record<string, string> {
  const sets = readOwnProperty(pluginSettings, 'knowledgeStoreCredentials');
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) return {};
  const value = readOwnProperty(sets, connectionId);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function writeConnectionCredentials(
  settings: Settings,
  providerId: string,
  connectionId: string,
  credentials: Record<string, string>,
): Settings {
  const providerSettings = readOwnRecord(settings.pluginSettings, providerId) ?? {};
  const existingSets = readOwnProperty(providerSettings, 'knowledgeStoreCredentials');
  const sets =
    existingSets && typeof existingSets === 'object' && !Array.isArray(existingSets)
      ? (existingSets as Record<string, unknown>)
      : {};
  const nextSets = { ...sets };
  if (Object.keys(credentials).length > 0) nextSets[connectionId] = credentials;
  else delete nextSets[connectionId];
  return {
    ...settings,
    pluginSettings: {
      ...(settings.pluginSettings ?? {}),
      [providerId]: {
        ...providerSettings,
        knowledgeStoreCredentials: nextSets,
      },
    },
  };
}

function removeConnectionCredentials(settings: Settings, providerId: string, connectionId: string): Settings {
  const providerSettings = readOwnRecord(settings.pluginSettings, providerId);
  if (!providerSettings) return settings;
  const sets = readOwnProperty(providerSettings, 'knowledgeStoreCredentials');
  if (!sets || typeof sets !== 'object' || Array.isArray(sets)) return settings;
  const nextSets = { ...(sets as Record<string, unknown>) };
  delete nextSets[connectionId];
  return {
    ...settings,
    pluginSettings: {
      ...(settings.pluginSettings ?? {}),
      [providerId]: { ...providerSettings, knowledgeStoreCredentials: nextSets },
    },
  };
}

function readOwnProperty(value: unknown, key: string): unknown {
  return hasOwnProperty(value, key) ? value[key] : undefined;
}

function hasOwnProperty(value: unknown, key: string): value is Record<string, unknown> {
  return (
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)
  );
}

function readOwnRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const property = readOwnProperty(value, key);
  return property && typeof property === 'object' && !Array.isArray(property)
    ? (property as Record<string, unknown>)
    : undefined;
}
