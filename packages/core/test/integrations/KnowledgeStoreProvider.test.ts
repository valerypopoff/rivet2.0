import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  KnowledgeStoreController,
  getKnowledgeStoreProvider,
  registerKnowledgeStoreProvider,
  type InternalProcessContext,
  type KnowledgeStoreConnectionDefinition,
  type Project,
  type RivetKnowledgeStore,
} from '../../src/index.js';

function makeStore(name: string): RivetKnowledgeStore & { name: string } {
  return {
    name,
    capabilities: {},
    async getSourceStatus({ source }) {
      return { exists: false, source, message: name };
    },
    async syncSource() {
      throw new Error('not used');
    },
    async search({ source }) {
      return { sourceFound: false, source, evidence: [], queryResults: [], message: name };
    },
  };
}

function makeContext(provider: string, executor: 'browser' | 'nodejs' = 'nodejs') {
  const project = {
    metadata: {
      id: 'knowledge-provider-project',
      title: 'Knowledge provider project',
      description: '',
      knowledgeStores: {
        primary: { displayName: 'Primary', provider, config: {} },
      },
    },
    graphs: {},
    plugins: [],
  } as unknown as Project;
  return { executor, project, settings: {} } as Pick<InternalProcessContext, 'executor' | 'project' | 'settings'>;
}

describe('KnowledgeStoreController', () => {
  it('rejects malformed provider definitions with controlled diagnostics', () => {
    const baseProvider = {
      id: `provider-shape-${Date.now()}`,
      displayName: 'Provider shape',
      connectionConfigSpec: [],
      supportedExecutors: ['nodejs'],
      createStore: () => makeStore('provider'),
    };
    for (const [override, expected] of [
      [{ connectionConfigSpec: null }, /connection fields as an array/],
      [{ supportedExecutors: null }, /must support an executor/],
      [{ createStore: null }, /store factory/],
      [{ connectionConfigSpec: [null] }, /invalid connection field/],
      [
        {
          connectionConfigSpec: [
            { key: 'region', label: 'Region', type: 'select', options: [{ label: '', value: 'us' }] },
          ],
        },
        /requires labeled options/,
      ],
    ] as const) {
      assert.throws(() => registerKnowledgeStoreProvider({ ...baseProvider, ...override } as never), expected);
    }
  });

  it('publishes an immutable provider snapshot instead of retaining mutable plugin arrays', () => {
    const providerId = `provider-snapshot-${Date.now()}`;
    const provider = {
      id: providerId,
      displayName: 'Snapshot provider',
      connectionConfigSpec: [{ key: 'host', label: 'Host', type: 'string' as const, default: 'original' }],
      supportedExecutors: ['nodejs' as const],
      createStore: () => makeStore('provider'),
    };
    registerKnowledgeStoreProvider(provider);

    provider.connectionConfigSpec[0]!.default = 'mutated';
    provider.connectionConfigSpec.push({ key: 'later', label: 'Later', type: 'string' });
    provider.supportedExecutors.length = 0;

    const registered = getKnowledgeStoreProvider(providerId)!;
    assert.equal(Object.isFrozen(registered), true);
    assert.equal(Object.isFrozen(registered.connectionConfigSpec), true);
    assert.deepEqual(registered.connectionConfigSpec, [
      { key: 'host', label: 'Host', type: 'string', default: 'original' },
    ]);
    assert.deepEqual(registered.supportedExecutors, ['nodejs']);
  });

  it('rejects provider and owning-plugin IDs that are unsafe as settings keys', () => {
    for (const [id, pluginId] of [
      ['__proto__', undefined],
      [`provider-reserved-plugin-${Date.now()}`, 'constructor'],
    ] as const) {
      assert.throws(
        () =>
          registerKnowledgeStoreProvider({
            id,
            ...(pluginId ? { pluginId } : {}),
            displayName: 'Invalid provider',
            connectionConfigSpec: [],
            supportedExecutors: ['nodejs'],
            createStore: () => makeStore('provider'),
          }),
        /reserved/,
      );
    }
  });

  it('rejects secret fields in portable connection configuration', () => {
    assert.throws(
      () =>
        registerKnowledgeStoreProvider({
          id: `provider-secret-config-${Date.now()}`,
          displayName: 'Invalid provider',
          connectionConfigSpec: [{ key: 'apiKey', label: 'API key', type: 'secret' }],
          supportedExecutors: ['nodejs'],
          createStore: () => makeStore('provider'),
        }),
      /must declare secret field "apiKey" as a credential/,
    );
  });

  it('rejects malformed host stores before a graph can use them', async () => {
    const controller = new KnowledgeStoreController({ primary: {} as RivetKnowledgeStore });
    await assert.rejects(
      () => controller.resolve('primary', makeContext('unused')),
      /did not resolve to a valid RivetKnowledgeStore/,
    );
    await assert.rejects(
      () =>
        new KnowledgeStoreController({
          primary: { ...makeStore('host'), capabilities: { supportedExecutors: ['deno'] } } as RivetKnowledgeStore,
        }).resolve('primary', makeContext('unused')),
      /invalid executor capabilities/,
    );
  });

  it('enforces executor restrictions declared by host-provided stores', async () => {
    const hostStore: RivetKnowledgeStore = {
      ...makeStore('host'),
      capabilities: { supportedExecutors: ['nodejs'] },
    };
    const controller = new KnowledgeStoreController({ primary: hostStore });
    await assert.rejects(
      () => controller.resolve('primary', makeContext('unused', 'browser')),
      /does not support the Browser executor/,
    );
  });

  it('prefers a host-provided store over project provider configuration', async () => {
    const providerId = `provider-host-precedence-${Date.now()}`;
    let factoryCalls = 0;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Test provider',
      connectionConfigSpec: [],
      supportedExecutors: ['nodejs'],
      createStore() {
        factoryCalls += 1;
        return makeStore('provider');
      },
    });
    const hostStore = makeStore('host');
    const controller = new KnowledgeStoreController({ primary: hostStore });

    assert.equal(await controller.resolve('primary', makeContext(providerId)), hostStore);
    assert.equal(factoryCalls, 0);
  });

  it('lazily creates and caches one project-backed store per root-run controller', async () => {
    const providerId = `provider-cache-${Date.now()}`;
    let factoryCalls = 0;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Test provider',
      connectionConfigSpec: [],
      supportedExecutors: ['nodejs'],
      createStore() {
        factoryCalls += 1;
        return makeStore(`provider-${factoryCalls}`);
      },
    });
    const controller = new KnowledgeStoreController(undefined);
    const context = makeContext(providerId);

    const [first, second] = await Promise.all([
      controller.resolve('primary', context),
      controller.resolve('primary', context),
    ]);

    assert.equal(first, second);
    assert.equal(factoryCalls, 1);
    assert.notEqual(await new KnowledgeStoreController(undefined).resolve('primary', context), first);
    assert.equal(factoryCalls, 2);
  });

  it('does not alias same-named connections from different projects in one root controller', async () => {
    const providerId = `provider-project-scope-${Date.now()}`;
    let factoryCalls = 0;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Project-scoped provider',
      connectionConfigSpec: [],
      supportedExecutors: ['nodejs'],
      createStore() {
        factoryCalls += 1;
        return makeStore(`project-${factoryCalls}`);
      },
    });
    const controller = new KnowledgeStoreController(undefined);
    const firstContext = makeContext(providerId);
    const secondContext = makeContext(providerId);

    const first = await controller.resolve('primary', firstContext);
    const second = await controller.resolve('primary', secondContext);

    assert.notEqual(first, second);
    assert.equal(factoryCalls, 2);
  });

  it('reports missing providers, missing connections, and unsupported executors clearly', async () => {
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('missing', makeContext('not-installed')),
      /was not found/,
    );
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', makeContext('not-installed')),
      /is not installed/,
    );

    const providerId = `provider-node-only-${Date.now()}`;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Node-only provider',
      connectionConfigSpec: [],
      supportedExecutors: ['nodejs'],
      createStore: () => makeStore('provider'),
    });
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', makeContext(providerId, 'browser')),
      /does not support the Browser executor/,
    );
  });

  it('validates project connection configuration before invoking a provider factory', async () => {
    const providerId = `provider-config-${Date.now()}`;
    let receivedConfig: unknown;
    let receivedCredentials: unknown;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Configured provider',
      connectionConfigSpec: [
        { key: 'host', label: 'Host', type: 'string', required: true },
        { key: 'limit', label: 'Limit', type: 'number', default: 10 },
      ],
      credentialConfigSpec: [{ key: 'token', label: 'Token', type: 'secret' }],
      supportedExecutors: ['nodejs'],
      createStore(_connectionId, definition, context) {
        receivedConfig = definition.config;
        receivedCredentials = context.credentials;
        return makeStore('provider');
      },
    });

    const validContext = makeContext(providerId);
    validContext.project.metadata.knowledgeStores!.primary!.config = { host: 'example.test' };
    validContext.settings.pluginSettings = {
      [providerId]: { knowledgeStoreCredentials: { primary: { token: 'local-secret', ignored: 'not-declared' } } },
    };
    await new KnowledgeStoreController(undefined).resolve('primary', validContext);
    assert.deepEqual(receivedConfig, { host: 'example.test', limit: 10 });
    assert.deepEqual(receivedCredentials, { token: 'local-secret' });

    const invalidContext = makeContext(providerId);
    invalidContext.project.metadata.knowledgeStores!.primary!.config = {
      host: 'example.test',
      apiKey: 'must-not-enter-portable-config',
    };
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', invalidContext),
      /unknown configuration field "apiKey"/,
    );

    const explicitNullContext = makeContext(providerId);
    explicitNullContext.project.metadata.knowledgeStores!.primary!.config = {
      host: 'example.test',
      limit: null,
    };
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', explicitNullContext),
      /invalid value for Limit/,
    );
  });

  it('enforces credential requirements and defaults consistently outside the editor', async () => {
    const providerId = `provider-required-credentials-${Date.now()}`;
    let receivedCredentials: unknown;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Credential provider',
      connectionConfigSpec: [],
      credentialConfigSpec: [
        { key: 'token', label: 'Access Token', type: 'secret', required: true },
        { key: 'region', label: 'Region', type: 'string', default: 'default-region' },
      ],
      supportedExecutors: ['nodejs'],
      createStore(_connectionId, _definition, context) {
        receivedCredentials = context.credentials;
        return makeStore('provider');
      },
    });

    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', makeContext(providerId)),
      /requires Access Token/,
    );

    const configured = makeContext(providerId);
    configured.settings.pluginSettings = {
      [providerId]: { knowledgeStoreCredentials: { primary: { token: 'secret' } } },
    };
    await new KnowledgeStoreController(undefined).resolve('primary', configured);
    assert.deepEqual(receivedCredentials, { token: 'secret', region: 'default-region' });

    const malformed = makeContext(providerId);
    malformed.settings.pluginSettings = {
      [providerId]: { knowledgeStoreCredentials: { primary: { token: 'secret', region: null } } },
    } as never;
    await assert.rejects(
      () => new KnowledgeStoreController(undefined).resolve('primary', malformed),
      /invalid stored credentials for Region/,
    );
  });

  it('does not mistake inherited object properties for provider configuration or credentials', async () => {
    const providerId = `provider-own-fields-${Date.now()}`;
    let observedConfig: KnowledgeStoreConnectionDefinition['config'] | undefined;
    let observedCredentials: Readonly<Record<string, string>> | undefined;
    registerKnowledgeStoreProvider({
      id: providerId,
      displayName: 'Own fields provider',
      connectionConfigSpec: [
        { key: 'toString', label: 'Config prototype name', type: 'string', required: true, default: 'config' },
      ],
      credentialConfigSpec: [
        { key: 'valueOf', label: 'Credential prototype name', type: 'secret', required: true, default: 'credential' },
      ],
      supportedExecutors: ['nodejs'],
      createStore: (_connectionId, definition, context) => {
        observedConfig = definition.config;
        observedCredentials = context.credentials;
        return makeStore('own-fields');
      },
    });

    await new KnowledgeStoreController(undefined).resolve('primary', makeContext(providerId));

    assert.deepEqual(observedConfig, { toString: 'config' });
    assert.deepEqual(observedCredentials, { valueOf: 'credential' });
  });
});
