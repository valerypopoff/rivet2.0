import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { KnowledgeStoreConnectionDefinition, KnowledgeStoreProviderDefinition } from '@valerypopoff/rivet2-core';
import {
  createExistingKnowledgeStoreDraft,
  createNewKnowledgeStoreDraft,
  duplicateKnowledgeStoreDraft,
  normalizeProjectKnowledgeStoreDraftFields,
  switchNewKnowledgeStoreDraftProvider,
} from './projectKnowledgeStoreDraft.js';

function provider(id: string, defaultHost: string): KnowledgeStoreProviderDefinition {
  return {
    id,
    displayName: id,
    connectionConfigSpec: [
      { key: 'host', label: 'Host', type: 'string', default: defaultHost },
      { key: 'enabled', label: 'Enabled', type: 'boolean' },
    ],
    credentialConfigSpec: [{ key: 'token', label: 'Token', type: 'secret' }],
    supportedExecutors: ['nodejs'],
    createStore() {
      throw new Error('not used');
    },
  };
}

const definition: KnowledgeStoreConnectionDefinition = {
  displayName: 'Primary',
  provider: 'first',
  config: { host: 'saved.example', enabled: true },
};

describe('project Knowledge Store drafts', () => {
  it('starts a new draft from provider defaults', () => {
    assert.deepEqual(createNewKnowledgeStoreDraft('new-id', provider('first', 'default.example')), {
      connectionId: 'new-id',
      displayName: '',
      providerId: 'first',
      config: { host: 'default.example', enabled: false },
      credentials: {},
      isNew: true,
    });
  });

  it('copies existing data into an isolated edit draft', () => {
    const existingDefinition: KnowledgeStoreConnectionDefinition = {
      ...definition,
      config: { ...definition.config },
    };
    const credentials = { token: 'local-secret' };
    const draft = createExistingKnowledgeStoreDraft('primary', existingDefinition, credentials);
    existingDefinition.config.host = 'mutated-after-open';
    credentials.token = 'mutated-after-open';

    assert.deepEqual(draft.config, { host: 'saved.example', enabled: true });
    assert.deepEqual(draft.credentials, { token: 'local-secret' });
    assert.equal(draft.isNew, false);
  });

  it('duplicates portable configuration but never credentials', () => {
    const draft = duplicateKnowledgeStoreDraft('duplicate-id', definition, [
      'Primary',
      'Primary copy',
      'PRIMARY COPY 2',
    ]);

    assert.equal(draft.displayName, 'Primary copy 3');
    assert.deepEqual(draft.config, definition.config);
    assert.notEqual(draft.config, definition.config);
    assert.deepEqual(draft.credentials, {});
    assert.equal(draft.isNew, true);
  });

  it('resets new drafts on provider changes and refuses changes for existing drafts', () => {
    const first = provider('first', 'first.example');
    const second = provider('second', 'second.example');
    const newDraft = {
      ...createNewKnowledgeStoreDraft('new-id', first),
      config: { host: 'unsaved.example' },
      credentials: { token: 'unsaved-secret' },
    };
    assert.deepEqual(switchNewKnowledgeStoreDraftProvider(newDraft, second), {
      ...newDraft,
      providerId: 'second',
      config: { host: 'second.example', enabled: false },
      credentials: {},
    });

    const existingDraft = createExistingKnowledgeStoreDraft('primary', definition, { token: 'local-secret' });
    assert.equal(switchNewKnowledgeStoreDraftProvider(existingDraft, second), existingDraft);
  });

  it('normalizes the unsaved draft used by save and connection tests with existing UI errors', () => {
    const configuredProvider: KnowledgeStoreProviderDefinition = {
      ...provider('configured', ''),
      connectionConfigSpec: [
        { key: 'host', label: 'Host', type: 'string', required: true },
        { key: 'enabled', label: 'Enabled', type: 'boolean' },
        { key: 'limit', label: 'Limit', type: 'number' },
        {
          key: 'region',
          label: 'Region',
          type: 'select',
          options: [{ label: 'US', value: 'us' }],
        },
      ],
      credentialConfigSpec: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
    };
    const draft = {
      ...createNewKnowledgeStoreDraft('new-id', configuredProvider),
      config: {
        host: 'unsaved.example',
        enabled: false,
        limit: 0,
        region: 'us',
        unknown: 'discarded',
      },
      credentials: { token: 'unsaved-secret', ignored: 'discarded' },
    };

    assert.deepEqual(normalizeProjectKnowledgeStoreDraftFields(draft, configuredProvider), {
      config: { host: 'unsaved.example', enabled: false, limit: 0, region: 'us' },
      credentials: { token: 'unsaved-secret' },
    });

    assert.throws(
      () =>
        normalizeProjectKnowledgeStoreDraftFields(
          { ...draft, config: { ...draft.config, limit: Number.NaN } },
          configuredProvider,
        ),
      new Error('Limit must be a finite number.'),
    );
    assert.throws(
      () =>
        normalizeProjectKnowledgeStoreDraftFields(
          { ...draft, config: { ...draft.config, host: [] } },
          configuredProvider,
        ),
      new Error('Host is required.'),
    );
    assert.throws(
      () => normalizeProjectKnowledgeStoreDraftFields({ ...draft, credentials: { token: ' ' } }, configuredProvider),
      new Error('Token is required.'),
    );
    assert.throws(
      () =>
        normalizeProjectKnowledgeStoreDraftFields(
          { ...draft, credentials: { token: null } as never },
          configuredProvider,
        ),
      new Error('Token must be a string.'),
    );
    assert.throws(
      () => normalizeProjectKnowledgeStoreDraftFields(draft, provider('another-provider', '')),
      new Error('Knowledge store draft provider "configured" does not match provider "another-provider".'),
    );
  });
});
