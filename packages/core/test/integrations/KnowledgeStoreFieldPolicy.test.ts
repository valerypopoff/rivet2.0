import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createKnowledgeStoreFieldDraftDefaults,
  isKnowledgeStoreProviderFieldDefaultValid,
  normalizeKnowledgeStoreConnectionDefinition,
  normalizeKnowledgeStoreConnectionDraftConfig,
  normalizeKnowledgeStoreCredentialFields,
  normalizeKnowledgeStoreProviderFieldValue,
  readKnowledgeStoreConnectionCredentialsDraft,
  readKnowledgeStoreConnectionCredentials,
  removeKnowledgeStoreConnectionCredentials,
  writeKnowledgeStoreConnectionCredentials,
  type KnowledgeStoreConnectionDefinition,
  type KnowledgeStoreProviderConfigField,
  type KnowledgeStoreProviderCredentialField,
  type KnowledgeStoreProviderDefinition,
  type Settings,
} from '../../src/index.js';

const connectionFields: KnowledgeStoreProviderConfigField[] = [
  { key: 'host', label: 'Host', type: 'string', required: true },
  { key: 'enabled', label: 'Enabled', type: 'boolean', default: false },
  { key: 'limit', label: 'Limit', type: 'number', default: 0 },
  {
    key: 'region',
    label: 'Region',
    type: 'select',
    default: 'us',
    options: [
      { label: 'US', value: 'us' },
      { label: 'EU', value: 'eu' },
    ],
  },
  { key: 'description', label: 'Description', type: 'string' },
];

const credentialFields: KnowledgeStoreProviderCredentialField[] = [
  { key: 'token', label: 'Access Token', type: 'secret', required: true },
  { key: 'account', label: 'Account', type: 'string', default: 'default-account' },
];

const provider = {
  id: 'policy-provider',
  pluginId: 'policy-plugin',
  connectionConfigSpec: connectionFields,
  credentialConfigSpec: credentialFields,
} satisfies Pick<KnowledgeStoreProviderDefinition, 'id' | 'pluginId' | 'connectionConfigSpec' | 'credentialConfigSpec'>;

describe('Knowledge Store field policy', () => {
  it('constructs draft defaults for every field type without losing false or zero', () => {
    assert.deepEqual(
      createKnowledgeStoreFieldDraftDefaults([...connectionFields, { key: 'secret', label: 'Secret', type: 'secret' }]),
      {
        host: '',
        enabled: false,
        limit: 0,
        region: 'us',
        description: '',
        secret: '',
      },
    );
  });

  it('normalizes one field into a secret-free structured issue', () => {
    const result = normalizeKnowledgeStoreProviderFieldValue(credentialFields[0]!, '   ', 'credential-draft');
    assert.deepEqual(result, {
      ok: false,
      issue: {
        code: 'required',
        fieldKey: 'token',
        fieldLabel: 'Access Token',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /super-secret/);

    assert.deepEqual(normalizeKnowledgeStoreProviderFieldValue(connectionFields[1]!, false, 'connection-runtime'), {
      ok: true,
      value: { present: true, value: false },
    });
    assert.deepEqual(normalizeKnowledgeStoreProviderFieldValue(connectionFields[2]!, 0, 'connection-runtime'), {
      ok: true,
      value: { present: true, value: 0 },
    });
    assert.equal(
      normalizeKnowledgeStoreProviderFieldValue(connectionFields[2]!, Number.NaN, 'connection-runtime').ok,
      false,
    );
    assert.equal(
      normalizeKnowledgeStoreProviderFieldValue(connectionFields[3]!, 'unknown', 'connection-runtime').ok,
      false,
    );
    assert.throws(
      () => normalizeKnowledgeStoreProviderFieldValue(connectionFields[0]!, 'example.test', 'invalid' as never),
      new Error('Unsupported Knowledge Store field normalization mode.'),
    );
  });

  it('preserves provider-registration default rules', () => {
    assert.equal(isKnowledgeStoreProviderFieldDefaultValid({ key: 'text', label: 'Text', type: 'string' }, ''), true);
    assert.equal(
      isKnowledgeStoreProviderFieldDefaultValid(
        { key: 'choice', label: 'Choice', type: 'select', options: [{ label: 'Empty', value: '' }] },
        '',
      ),
      true,
    );
    assert.equal(
      isKnowledgeStoreProviderFieldDefaultValid(
        { key: 'choice', label: 'Choice', type: 'select', options: [{ label: 'US', value: 'us' }] },
        '',
      ),
      false,
    );
    assert.equal(
      isKnowledgeStoreProviderFieldDefaultValid({ key: 'count', label: 'Count', type: 'number' }, Infinity),
      false,
    );
  });

  it('uses declared fields as the draft schema and silently drops unknown draft keys', () => {
    const values = Object.assign(Object.create(null) as Record<string, unknown>, {
      host: 'example.test',
      enabled: false,
      limit: 0,
      unknown: 'discarded',
    });
    assert.deepEqual(normalizeKnowledgeStoreConnectionDraftConfig(connectionFields, values), {
      ok: true,
      value: {
        host: 'example.test',
        enabled: false,
        limit: 0,
        region: 'us',
      },
    });
    assert.deepEqual(
      normalizeKnowledgeStoreConnectionDraftConfig(connectionFields, {
        host: 'example.test',
        region: undefined,
      }),
      {
        ok: true,
        value: { host: 'example.test', enabled: false, limit: 0 },
      },
    );
    assert.deepEqual(normalizeKnowledgeStoreConnectionDraftConfig(connectionFields, { host: [] }), {
      ok: false,
      issue: { code: 'required', fieldKey: 'host', fieldLabel: 'Host' },
    });

    assert.deepEqual(normalizeKnowledgeStoreConnectionDraftConfig(connectionFields, { host: ' ' }), {
      ok: false,
      issue: { code: 'required', fieldKey: 'host', fieldLabel: 'Host' },
    });
    assert.deepEqual(
      normalizeKnowledgeStoreConnectionDraftConfig(connectionFields, {
        host: 'example.test',
        enabled: 'yes',
      }),
      {
        ok: false,
        issue: { code: 'expected-boolean', fieldKey: 'enabled', fieldLabel: 'Enabled' },
      },
    );
  });

  it('strictly normalizes persisted definitions and preserves runtime diagnostics', () => {
    const definition: KnowledgeStoreConnectionDefinition = {
      displayName: '  Primary  ',
      provider: provider.id,
      config: Object.assign(Object.create(null) as Record<string, unknown>, {
        host: 'example.test',
      }),
    };
    assert.deepEqual(normalizeKnowledgeStoreConnectionDefinition('primary', definition, provider), {
      displayName: 'Primary',
      provider: 'policy-provider',
      pluginId: 'policy-plugin',
      config: {
        host: 'example.test',
        enabled: false,
        limit: 0,
        region: 'us',
      },
    });

    assert.throws(
      () =>
        normalizeKnowledgeStoreConnectionDefinition(
          'primary',
          { ...definition, config: { host: 'example.test', unknown: true } },
          provider,
        ),
      new Error('Knowledge store connection "Primary" contains unknown configuration field "unknown".'),
    );
    assert.throws(
      () =>
        normalizeKnowledgeStoreConnectionDefinition(
          'primary',
          { ...definition, config: { host: 'example.test', limit: null } },
          provider,
        ),
      new Error('Knowledge store connection "Primary" has an invalid value for Limit.'),
    );
    assert.throws(
      () =>
        normalizeKnowledgeStoreConnectionDefinition('primary', { ...definition, pluginId: 'another-plugin' }, provider),
      new Error('Knowledge store connection "Primary" names the wrong owning plugin.'),
    );
    assert.throws(
      () =>
        normalizeKnowledgeStoreConnectionDefinition(
          'primary',
          { ...definition, provider: 'another-provider' },
          provider,
        ),
      new Error('Knowledge store connection "Primary" names the wrong provider.'),
    );
    assert.throws(
      () => normalizeKnowledgeStoreConnectionDefinition('primary', { ...definition, config: [] as never }, provider),
      new Error('Knowledge store connection "Primary" has invalid provider configuration.'),
    );
    assert.throws(
      () =>
        normalizeKnowledgeStoreConnectionDefinition(
          'primary',
          { ...definition, config: { host: [] as never } },
          provider,
        ),
      new Error('Knowledge store connection "Primary" has an invalid value for Host.'),
    );
  });

  it('normalizes credentials without retaining unknown values or exposing secrets in issues', () => {
    assert.deepEqual(
      normalizeKnowledgeStoreCredentialFields(credentialFields, {
        token: 'super-secret',
        ignored: 'not-declared',
      }),
      {
        ok: true,
        value: { token: 'super-secret', account: 'default-account' },
      },
    );

    const invalid = normalizeKnowledgeStoreCredentialFields(credentialFields, {
      token: 'super-secret',
      account: null,
    });
    assert.deepEqual(invalid, {
      ok: false,
      issue: { code: 'expected-string', fieldKey: 'account', fieldLabel: 'Account' },
    });
    assert.doesNotMatch(JSON.stringify(invalid), /super-secret/);

    for (const value of [null, undefined]) {
      assert.deepEqual(normalizeKnowledgeStoreCredentialFields(credentialFields, { token: value }), {
        ok: false,
        issue: { code: 'expected-string', fieldKey: 'token', fieldLabel: 'Access Token' },
      });
    }
    assert.deepEqual(normalizeKnowledgeStoreCredentialFields(credentialFields, {}), {
      ok: false,
      issue: { code: 'required', fieldKey: 'token', fieldLabel: 'Access Token' },
    });
  });

  it('reads normal, malformed, and prototype-less credential settings safely', () => {
    const storedCredentials = Object.assign(Object.create(null) as Record<string, unknown>, {
      token: 'super-secret',
      ignored: 'not-declared',
    });
    const credentialSets = Object.assign(Object.create(null) as Record<string, unknown>, {
      primary: storedCredentials,
    });
    const providerSettings = Object.assign(Object.create(null) as Record<string, unknown>, {
      knowledgeStoreCredentials: credentialSets,
    });
    const pluginSettings = Object.assign(Object.create(null) as Record<string, Record<string, unknown>>, {
      [provider.id]: providerSettings,
    });
    const settings: Settings = { pluginSettings };

    assert.deepEqual(readKnowledgeStoreConnectionCredentials(settings, provider, 'primary'), {
      ok: true,
      value: { token: 'super-secret', account: 'default-account' },
    });
    assert.deepEqual(readKnowledgeStoreConnectionCredentialsDraft(settings, provider, 'primary'), {
      token: 'super-secret',
    });

    assert.deepEqual(
      readKnowledgeStoreConnectionCredentials(
        { pluginSettings: { [provider.id]: { knowledgeStoreCredentials: 'malformed' } } },
        provider,
        'primary',
      ),
      {
        ok: false,
        issue: { code: 'required', fieldKey: 'token', fieldLabel: 'Access Token' },
      },
    );

    assert.deepEqual(
      readKnowledgeStoreConnectionCredentials(
        {
          pluginSettings: {
            [provider.id]: { knowledgeStoreCredentials: { primary: { token: null } } },
          },
        } as never,
        provider,
        'primary',
      ),
      {
        ok: false,
        issue: { code: 'expected-string', fieldKey: 'token', fieldLabel: 'Access Token' },
      },
    );
    assert.deepEqual(
      readKnowledgeStoreConnectionCredentials(
        {
          pluginSettings: {
            [provider.id]: { knowledgeStoreCredentials: { primary: { token: undefined } } },
          },
        } as never,
        provider,
        'primary',
      ),
      {
        ok: false,
        issue: { code: 'required', fieldKey: 'token', fieldLabel: 'Access Token' },
      },
    );
  });

  it('writes, replaces, clears, and removes only one immutable credential entry', () => {
    const settings: Settings = {
      pluginSettings: {
        [provider.id]: {
          untouched: true,
          knowledgeStoreCredentials: {
            primary: { token: 'old-secret' },
            secondary: { token: 'secondary-secret' },
          },
        },
        other: { untouched: true },
      },
    };
    const credentials = { token: 'new-secret' };
    const written = writeKnowledgeStoreConnectionCredentials(settings, provider.id, 'primary', credentials);
    credentials.token = 'mutated-after-write';

    assert.notEqual(written, settings);
    assert.deepEqual(written.pluginSettings?.[provider.id], {
      untouched: true,
      knowledgeStoreCredentials: {
        primary: { token: 'new-secret' },
        secondary: { token: 'secondary-secret' },
      },
    });
    assert.deepEqual(settings.pluginSettings?.[provider.id]?.knowledgeStoreCredentials, {
      primary: { token: 'old-secret' },
      secondary: { token: 'secondary-secret' },
    });

    const cleared = writeKnowledgeStoreConnectionCredentials(written, provider.id, 'primary', {});
    assert.deepEqual(cleared.pluginSettings?.[provider.id]?.knowledgeStoreCredentials, {
      secondary: { token: 'secondary-secret' },
    });

    const removed = removeKnowledgeStoreConnectionCredentials(settings, provider.id, 'primary');
    assert.deepEqual(removed.pluginSettings?.[provider.id]?.knowledgeStoreCredentials, {
      secondary: { token: 'secondary-secret' },
    });
    assert.equal(removeKnowledgeStoreConnectionCredentials(settings, 'missing', 'primary'), settings);

    const onlyEntry: Settings = {
      pluginSettings: {
        [provider.id]: { knowledgeStoreCredentials: { primary: { token: 'old-secret' } } },
      },
    };
    assert.deepEqual(
      writeKnowledgeStoreConnectionCredentials(onlyEntry, provider.id, 'primary', {}).pluginSettings?.[provider.id],
      { knowledgeStoreCredentials: {} },
    );
    assert.deepEqual(
      removeKnowledgeStoreConnectionCredentials(onlyEntry, provider.id, 'primary').pluginSettings?.[provider.id],
      { knowledgeStoreCredentials: {} },
    );

    const malformed = { pluginSettings: [] } as unknown as Settings;
    assert.deepEqual(
      writeKnowledgeStoreConnectionCredentials(malformed, provider.id, 'primary', { token: 'malformed-secret' }),
      {
        pluginSettings: {
          [provider.id]: { knowledgeStoreCredentials: { primary: { token: 'malformed-secret' } } },
        },
      },
    );
    assert.equal(removeKnowledgeStoreConnectionCredentials(malformed, provider.id, 'primary'), malformed);
  });

  it('writes dynamic settings keys as own data without invoking object prototype setters', () => {
    const dynamicCredentials = Object.fromEntries([['__proto__', 'local-secret']]);
    const written = writeKnowledgeStoreConnectionCredentials({}, '__proto__', '__proto__', dynamicCredentials);
    const pluginSettings = written.pluginSettings as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(pluginSettings), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(pluginSettings, '__proto__'), true);

    const providerSettings = pluginSettings['__proto__'] as Record<string, unknown>;
    const credentialSets = providerSettings.knowledgeStoreCredentials as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(credentialSets), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(credentialSets, '__proto__'), true);
    assert.deepEqual(credentialSets['__proto__'], dynamicCredentials);

    const draft = readKnowledgeStoreConnectionCredentialsDraft(
      written,
      {
        id: '__proto__',
        credentialConfigSpec: [{ key: '__proto__', label: 'Dynamic credential', type: 'secret' }],
      },
      '__proto__',
    );
    assert.equal(Object.getPrototypeOf(draft), Object.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(draft, '__proto__'), true);
    assert.equal(draft['__proto__'], 'local-secret');
  });

  it('keeps credentials outside portable project definitions', () => {
    const definition = normalizeKnowledgeStoreConnectionDefinition(
      'primary',
      { displayName: 'Primary', provider: provider.id, config: { host: 'example.test' } },
      provider,
    );
    const savedSettings = writeKnowledgeStoreConnectionCredentials({}, provider.id, 'primary', {
      token: 'super-secret',
    });

    assert.doesNotMatch(JSON.stringify(definition), /super-secret|token/);
    assert.match(JSON.stringify(savedSettings), /super-secret/);
  });
});
