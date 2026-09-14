import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { clientMatchesNetworks, normalizeClientNetwork } from '../client-networks.js';
import { getExpectedExecutorAuthToken, getExpectedProxyAuthToken, getExpectedUiSessionToken, getVerifiedClientAddress, isTrustedClientRequest } from '../auth.js';
import { readTrustedClientSettings, trustedClientSettingsRepository, writeTrustedClientSettings } from '../trusted-client-settings.js';
import { requireOperatorAuth } from '../middleware/auth.js';
import { isDevelopmentAuthRequest } from '../development-auth.js';
import { completeServerUiOAuthCallback, createDummyOAuthCode, readServerUiOAuthSession } from '../server-ui-auth.js';
import { writeWebAppAuthSettings } from '../web-app-auth-settings.js';
import { runWithAppSettingsSnapshot } from '../app-settings/settings-repository.js';
import { watchAuthorization } from '../watch-authorization.js';
import { openWorkflowTreeEventStream } from '../routes/workflows/workflow-tree-events.js';
import { openEvaluationLibraryEventStream } from '../routes/workflows/evaluation-library-events.js';
import { runtimeLibrariesRouter } from '../routes/runtime-libraries.js';
import { getRuntimeLibrariesBackend } from '../runtime-libraries/backend.js';
import { streamManagedRuntimeLibraryJob } from '../runtime-libraries/managed/job-stream.js';
import { jobRunner } from '../runtime-libraries/job-runner.js';
import type { RuntimeLibraryJobState } from '../../../studio-server-shared/runtime-library-types.js';

async function isolated(run: () => Promise<void>) {
  const keys = ['RIVET_APP_DATA_ROOT', 'RIVET_KEY', 'RIVET_SERVER_UI_AUTH_MODE', 'RIVET_ENABLE_DEVELOPMENT_AUTH', 'RIVET_DEVELOPMENT_AUTH_CLIENTS'];
  const before = keys.map((key) => process.env[key]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-trusted-clients-'));
  try {
    process.env.RIVET_APP_DATA_ROOT = root;
    process.env.RIVET_KEY = 'test-only';
    process.env.RIVET_SERVER_UI_AUTH_MODE = 'key';
    delete process.env.RIVET_ENABLE_DEVELOPMENT_AUTH;
    delete process.env.RIVET_DEVELOPMENT_AUTH_CLIENTS;
    await run();
  } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
    await fs.rm(root, { recursive: true, force: true });
  }
}

function request(address: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'x-rivet-proxy-auth': getExpectedProxyAuthToken(), 'x-rivet-client-ip': address, ...extra };
  return { headers, protocol: 'http', get: (name: string) => headers[name.toLowerCase()] } as unknown as express.Request;
}

test('strict IP/network matching normalizes networks and mapped clients', () => {
  assert.equal(normalizeClientNetwork('10.20.3.4/16'), '10.20.0.0/16');
  assert.equal(normalizeClientNetwork('2001:db8:1234:abcd::/48'), '2001:db8:1234::/48');
  assert.equal(clientMatchesNetworks('::ffff:10.20.2.3', ['10.20.0.0/16']), true);
  assert.equal(clientMatchesNetworks('10.21.2.3', ['10.20.0.0/16']), false);
  assert.equal(clientMatchesNetworks('2001:db8:1234::1', ['2001:db8:1234::/48']), true);
  for (const value of ['localhost', '127.1', '0x7f000001', '0.0.0.0/0', '::/0', '10.0.0.1/33', '::1/129', 'fe80::1%eth0', 'https://10.0.0.1', '10.0.0.1/8/9']) {
    assert.throws(() => normalizeClientNetwork(value), Error, value);
  }
});

test('legacy hostname policy is retained but never grants bypass', () => isolated(async () => {
  const settingsPath = trustedClientSettingsRepository.descriptor.getPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ trustedHosts: ['localhost', 'internal.example.test'] }));
  const settings = await readTrustedClientSettings();
  assert.deepEqual(settings.trustedClients, []);
  assert.deepEqual(settings.legacyTrustedHosts, ['localhost', 'internal.example.test']);
  assert.equal(isTrustedClientRequest(request('127.0.0.1', { host: 'localhost', 'x-rivet-token-free-host': '1' })), false);
  await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
  assert.equal(isTrustedClientRequest(request('10.20.1.2', { host: 'arbitrary.example' })), true);
  assert.equal(isTrustedClientRequest(request('203.0.113.1', { host: 'localhost', 'x-forwarded-for': '10.20.1.2' })), false);
  assert.equal(getVerifiedClientAddress(request('10.20.1.2', { 'x-rivet-proxy-auth': 'forged' })), null);
  assert.equal(getVerifiedClientAddress(request('10.20.1.2, 203.0.113.1')), null);
  await assert.rejects(writeTrustedClientSettings({ trustedHosts: ['localhost'] }), /retired/);
}));

test('real HTTP operator gate ignores stale proxy hostname approval', () => isolated(async () => {
  await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
  const app = express();
  app.use(requireOperatorAuth);
  app.get('/', (_req, res) => res.sendStatus(204));
  app.get('/workflows/execution-environment', (_req, res) => res.sendStatus(204));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  try {
    const headers = { 'x-rivet-proxy-auth': getExpectedProxyAuthToken(), 'x-rivet-token-free-host': '1', host: 'localhost' };
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`, { headers })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`, { headers: { ...headers, 'x-rivet-client-ip': '10.20.1.2' } })).status, 204);
    const serviceHeaders = { ...headers, 'x-rivet-executor-auth': getExpectedExecutorAuthToken() };
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/workflows/execution-environment`, { headers: serviceHeaders })).status, 204);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}`, { headers: serviceHeaders })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}));

test('policy revocation escapes the opening request snapshot', () => isolated(async () => {
  await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
  let revoked = 0;
  const stop = runWithAppSettingsSnapshot(() => watchAuthorization(() => isTrustedClientRequest(request('10.20.1.2')), () => revoked++));
  try {
    await writeTrustedClientSettings({ trustedClients: [] });
    assert.equal(revoked, 1);
    await writeTrustedClientSettings({ trustedClients: [] });
    assert.equal(revoked, 1);
  } finally { stop(); }
}));

const runningJob: RuntimeLibraryJobState = {
  id: 'test-job', type: 'install', status: 'running', packages: [], logs: [], logEntries: [],
  createdAt: '2026-09-13T00:00:00Z', lastProgressAt: '2026-09-13T00:00:00Z',
};

for (const kind of ['tree', 'evaluation', 'filesystem-job', 'managed-job'] as const) {
  for (const withCookie of [false, true]) {
    test(`${kind} stream policy revocation ${withCookie ? 'preserves a valid login' : 'closes trusted-only access'}`, (t) => isolated(async () => {
      await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
      const app = express();
      let activeResponse: express.Response | undefined;
      app.use((_req, res, next) => {
        activeResponse = res;
        runWithAppSettingsSnapshot(next);
      });
      app.use(requireOperatorAuth);
      let eventPath = '/events';
      const logListeners = jobRunner.listenerCount('log');
      const statusListeners = jobRunner.listenerCount('status');
      if (kind === 'filesystem-job' || kind === 'managed-job') {
        if (kind === 'managed-job') {
          t.mock.method(getRuntimeLibrariesBackend(), 'streamJob', (req: express.Request, res: express.Response) =>
            streamManagedRuntimeLibraryJob(req, res, { getJob: async () => runningJob }));
        } else {
          t.mock.method(jobRunner, 'getJob', () => runningJob);
        }
        app.use('/runtime-libraries', runtimeLibrariesRouter);
        eventPath = '/runtime-libraries/jobs/test-job/stream';
      } else {
        app.get(eventPath, (req, res) => kind === 'tree'
          ? openWorkflowTreeEventStream(req, res)
          : openEvaluationLibraryEventStream(req, res, 0));
      }
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}${eventPath}`, {
          headers: {
            'x-rivet-proxy-auth': getExpectedProxyAuthToken(), 'x-rivet-client-ip': '10.20.1.2',
            ...(withCookie ? { cookie: `rivet_ui_token=${getExpectedUiSessionToken()}` } : {}),
          },
          signal: controller.signal,
        });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /(?:tree|library)-state|"status":"running"/);
        await writeTrustedClientSettings({ trustedClients: [] });
        assert.equal(activeResponse?.writableEnded, !withCookie);
        if (withCookie) activeResponse!.end();
        assert.equal((await reader.read()).done, true);
        assert.equal(jobRunner.listenerCount('log'), logListeners);
        assert.equal(jobRunner.listenerCount('status'), statusListeners);
      } finally {
        clearTimeout(timeout);
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }));
  }
}

test('malformed optional trust policy revokes bypass without blocking ordinary login or overwriting evidence', () => isolated(async () => {
  await writeTrustedClientSettings({ trustedClients: ['10.20.0.0/16'] });
  let revoked = 0;
  const stop = watchAuthorization(() => isTrustedClientRequest(request('10.20.1.2')), () => revoked++);
  const settingsPath = trustedClientSettingsRepository.descriptor.getPath();
  const app = express();
  app.use((_req, _res, next) => runWithAppSettingsSnapshot(next));
  app.use(requireOperatorAuth);
  app.get('/', (_req, res) => res.sendStatus(204));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
  try {
    for (const malformed of ['{', '{"trustedClients":["localhost"]}', '{"version":999}']) {
      await fs.writeFile(settingsPath, malformed);
      const settings = await readTrustedClientSettings();
      assert.deepEqual(settings.trustedClients, []);
      assert.ok(settings.policyError);
      assert.equal(isTrustedClientRequest(request('10.20.1.2')), false);
      assert.equal(await fs.readFile(settingsPath, 'utf8'), malformed);
      const headers = { 'x-rivet-proxy-auth': getExpectedProxyAuthToken(), 'x-rivet-client-ip': '10.20.1.2' };
      assert.equal((await fetch(url, { headers })).status, 403);
      assert.equal((await fetch(url, { headers: { ...headers, cookie: `rivet_ui_token=${getExpectedUiSessionToken()}` } })).status, 204);
      await assert.rejects(writeTrustedClientSettings({}), /corrected/);
    }
    assert.equal(revoked, 1);
    const repaired = await writeTrustedClientSettings({ trustedClients: [] });
    assert.equal(repaired.policyError, undefined);
    trustedClientSettingsRepository.invalidate(settingsPath);
    assert.equal((await readTrustedClientSettings()).policyError, undefined);
    // Infrastructure failures must not be reinterpreted as an optional bad policy.
    await fs.rm(settingsPath);
    await fs.mkdir(settingsPath);
    await assert.rejects(readTrustedClientSettings());
  } finally {
    stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));

test('dummy OAuth requires deployment opt-in and its cookies cannot leave the allowed network', () => isolated(async () => {
  process.env.RIVET_SERVER_UI_AUTH_MODE = 'oauth';
  await writeWebAppAuthSettings({ provider: 'dummy', dummyAllowNonLocalhost: true, serverUiAdminEmails: ['admin@example.test'], sessionSecret: 'test-session' });
  const local = request('127.0.0.1', { host: 'localhost' });
  assert.equal(isDevelopmentAuthRequest(local), false);
  process.env.RIVET_ENABLE_DEVELOPMENT_AUTH = 'true';
  process.env.RIVET_DEVELOPMENT_AUTH_CLIENTS = '127.0.0.1';
  const cookie = await completeServerUiOAuthCallback(local, createDummyOAuthCode('admin@example.test'));
  assert.ok(readServerUiOAuthSession(request('127.0.0.1', { cookie })));
  assert.equal(readServerUiOAuthSession(request('203.0.113.1', { host: 'localhost', cookie })), null);
  delete process.env.RIVET_ENABLE_DEVELOPMENT_AUTH;
  assert.equal(readServerUiOAuthSession(request('127.0.0.1', { cookie })), null);
}));
