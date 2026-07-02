import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bootstrapProxySettings = await import(
  new URL('../../../../wrapper/bootstrap/proxy-bootstrap/node-executor-proxy-settings.mjs', import.meta.url).href
) as {
  NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH: string;
  applyNodeExecutorProxySettingsToEnv(settings: unknown): void;
  getNodeExecutorProxySettingsPath(): string;
  loadAndApplyNodeExecutorProxySettings(options?: {
    quiet?: boolean;
    configureDispatcher?: boolean;
    clearBeforeLoad?: boolean;
    clearWhenMissing?: boolean;
  }): Promise<boolean>;
  normalizeNodeExecutorProxySettings(settings: unknown): {
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  };
};

const relevantEnvKeys = [
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'RIVET_APP_DATA_ROOT',
  'RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH',
] as const;

async function withProxySettingsEnv(run: (tempRoot: string) => Promise<void> | void) {
  const previous = new Map<string, string | undefined>();
  for (const key of relevantEnvKeys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-node-executor-proxy-'));
  process.env.HOME = tempRoot;

  try {
    await run(tempRoot);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const key of relevantEnvKeys) {
      const value = previous.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Node executor proxy bootstrap uses the executor app-data settings path by default', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    assert.equal(
      bootstrapProxySettings.getNodeExecutorProxySettingsPath(),
      path.join(tempRoot, '.local', 'share', 'com.valerypopoff.rivet2', 'settings', 'node-executor-proxy.json'),
    );
  });
});

test('Node executor proxy bootstrap uses the API app-data settings path when available', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'api-app-data');

    assert.equal(
      bootstrapProxySettings.getNodeExecutorProxySettingsPath(),
      path.join(tempRoot, 'api-app-data', 'settings', 'node-executor-proxy.json'),
    );
  });
});

test('Node executor proxy bootstrap keeps explicit settings path as the highest priority', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    process.env.RIVET_APP_DATA_ROOT = path.join(tempRoot, 'api-app-data');
    process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH = path.join(tempRoot, 'custom', 'proxy.json');

    assert.equal(
      bootstrapProxySettings.getNodeExecutorProxySettingsPath(),
      path.join(tempRoot, 'custom', 'proxy.json'),
    );
  });
});

test('Node executor proxy bootstrap applies saved values to upper and lower env names', async () => {
  await withProxySettingsEnv(async () => {
    process.env.ALL_PROXY = 'http://all-proxy.local:3128';
    process.env.all_proxy = 'http://all-proxy.local:3128';

    bootstrapProxySettings.applyNodeExecutorProxySettingsToEnv({
      httpProxy: 'http://proxy.local:3128',
      httpsProxy: 'http://secure-proxy.local:3128',
      noProxy: 'localhost,api,executor',
    });

    assert.equal(process.env.HTTP_PROXY, 'http://proxy.local:3128');
    assert.equal(process.env.http_proxy, 'http://proxy.local:3128');
    assert.equal(process.env.HTTPS_PROXY, 'http://secure-proxy.local:3128');
    assert.equal(process.env.https_proxy, 'http://secure-proxy.local:3128');
    assert.equal(process.env.NO_PROXY, 'localhost,api,executor');
    assert.equal(process.env.no_proxy, 'localhost,api,executor');
    assert.equal(process.env.ALL_PROXY, undefined);
    assert.equal(process.env.all_proxy, undefined);

    bootstrapProxySettings.applyNodeExecutorProxySettingsToEnv({
      httpProxy: '',
      httpsProxy: '',
      noProxy: '',
    });

    assert.equal(process.env.HTTP_PROXY, undefined);
    assert.equal(process.env.http_proxy, undefined);
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.https_proxy, undefined);
    assert.equal(process.env.NO_PROXY, undefined);
    assert.equal(process.env.no_proxy, undefined);
  });
});

test('Node executor proxy bootstrap loads persisted settings before the executor starts', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    const settingsPath = path.join(tempRoot, bootstrapProxySettings.NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH);
    process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH = settingsPath;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      httpProxy: 'http://saved.local:3128',
      httpsProxy: '',
      noProxy: 'localhost,executor',
    }));

    assert.equal(await bootstrapProxySettings.loadAndApplyNodeExecutorProxySettings({
      quiet: true,
      configureDispatcher: false,
    }), true);
    assert.equal(process.env.HTTP_PROXY, 'http://saved.local:3128');
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.NO_PROXY, 'localhost,executor');
  });
});

test('Node executor proxy bootstrap loads persisted settings before API endpoint execution starts', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    const appDataRoot = path.join(tempRoot, 'api-app-data');
    const settingsPath = path.join(appDataRoot, bootstrapProxySettings.NODE_EXECUTOR_PROXY_SETTINGS_RELATIVE_PATH);
    process.env.RIVET_APP_DATA_ROOT = appDataRoot;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      httpProxy: 'http://api-proxy.local:3128',
      httpsProxy: 'http://api-secure-proxy.local:3128',
      noProxy: 'localhost,api',
    }));

    assert.equal(await bootstrapProxySettings.loadAndApplyNodeExecutorProxySettings({
      quiet: true,
      configureDispatcher: false,
    }), true);
    assert.equal(process.env.HTTP_PROXY, 'http://api-proxy.local:3128');
    assert.equal(process.env.HTTPS_PROXY, 'http://api-secure-proxy.local:3128');
    assert.equal(process.env.NO_PROXY, 'localhost,api');
  });
});

test('Node executor proxy bootstrap ignores environment proxy defaults when no app settings file exists', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH = path.join(tempRoot, 'missing', 'node-executor-proxy.json');
    process.env.HTTP_PROXY = 'http://env-proxy.local:3128';
    process.env.HTTPS_PROXY = 'http://env-secure-proxy.local:3128';
    process.env.ALL_PROXY = 'http://env-all-proxy.local:3128';
    process.env.http_proxy = 'http://env-lower-proxy.local:3128';
    process.env.NO_PROXY = 'localhost,api';
    process.env.no_proxy = 'localhost,lower';

    assert.equal(await bootstrapProxySettings.loadAndApplyNodeExecutorProxySettings({
      quiet: true,
      configureDispatcher: false,
      clearBeforeLoad: true,
      clearWhenMissing: true,
    }), true);
    assert.equal(process.env.HTTP_PROXY, undefined);
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.ALL_PROXY, undefined);
    assert.equal(process.env.http_proxy, undefined);
    assert.equal(process.env.NO_PROXY, undefined);
    assert.equal(process.env.no_proxy, undefined);
  });
});

test('Node executor proxy bootstrap can clear runtime proxy values after a managed settings file disappears', async () => {
  await withProxySettingsEnv(async (tempRoot) => {
    process.env.RIVET_NODE_EXECUTOR_PROXY_SETTINGS_PATH = path.join(tempRoot, 'missing', 'node-executor-proxy.json');
    process.env.HTTP_PROXY = 'http://stale-proxy.local:3128';
    process.env.HTTPS_PROXY = 'http://stale-secure-proxy.local:3128';
    process.env.NO_PROXY = 'localhost,api';

    assert.equal(await bootstrapProxySettings.loadAndApplyNodeExecutorProxySettings({
      quiet: true,
      configureDispatcher: false,
      clearWhenMissing: true,
    }), true);
    assert.equal(process.env.HTTP_PROXY, undefined);
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.NO_PROXY, undefined);
  });
});

test('Node executor proxy bootstrap normalizes legacy uppercase file keys', () => {
  assert.deepEqual(bootstrapProxySettings.normalizeNodeExecutorProxySettings({
    HTTP_PROXY: ' http://proxy.local:3128 ',
    HTTPS_PROXY: ' http://secure.local:3128 ',
    NO_PROXY: ' localhost ',
  }), {
    httpProxy: 'http://proxy.local:3128',
    httpsProxy: 'http://secure.local:3128',
    noProxy: 'localhost',
  });
});
