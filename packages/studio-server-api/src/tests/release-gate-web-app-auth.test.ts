import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import express from 'express';
import { createFilesystemWorkflowSuiteHarness } from './helpers/workflow-filesystem-suite-harness.js';
import {
  createWebAppProjectWithUiGraphs,
  serializeWebAppProject,
  extractWebAppRevisionKey,
  WEB_APP_TEST_ACTION_COMPONENT_ID,
} from './helpers/workflow-web-app-fixtures.js';
import { listenTestServer } from './helpers/http-server-harness.js';
import { withEnvOverride } from './helpers/workflow-api-harness.js';
import { getExpectedProxyAuthToken, getExpectedUiSessionToken } from '../auth.js';
import { writeTrustedClientSettings } from '../trusted-client-settings.js';
import { writeWebAppAuthSettings } from '../web-app-auth-settings.js';

const suite = await createFilesystemWorkflowSuiteHarness();
const { createApiApp } = await import('../app.js');
const { ReusableProviderGate } = await import(
  new URL('../../../../deploy/studio-server/scripts/qualification/provider-gate.mjs', import.meta.url).href
);

test.beforeEach(suite.resetAndEnsureWorkflowsRoot);
test.after(suite.cleanupWorkflowSuite);

for (const retainedOAuth of [false, true]) {
  test(`qualification session authenticates real published/latest routes with ${retainedOAuth ? 'retained OAuth' : 'fresh settings'}`, async () => {
    const values: Record<string, string> = {
      RIVET_KEY: 'release-gate-test-only',
      RIVET_SERVER_UI_AUTH_MODE: 'key',
      RIVET_ENABLE_DEVELOPMENT_AUTH: 'true',
      RIVET_DEVELOPMENT_AUTH_CLIENTS: '198.51.100.10',
    };
    const entries = Object.entries(values);
    const run = async (index = 0): Promise<void> => {
      if (index < entries.length) {
        const [key, value] = entries[index]!;
        return withEnvOverride(key, value, () => run(index + 1));
      }
      await writeTrustedClientSettings({ trustedClients: [] });
      await writeWebAppAuthSettings(
        retainedOAuth
          ? {
              mode: 'oauth',
              provider: 'dummy',
              dummyEmail: 'old@example.test',
              sessionSecret: 'previous-operation-test-only',
            }
          : { mode: 'ui-gate' },
      );
      const created = await suite.workflowMutations.createWorkflowProjectItem('', 'Release gate OAuth');
      const project = createWebAppProjectWithUiGraphs(
        suite.rivetNode,
        suite.workflowFs.createBlankProjectFile('Release gate OAuth'),
        [['release-gate-web-app', 'Managed release gate app']],
      );
      await fs.writeFile(created.absolutePath, serializeWebAppProject(suite.rivetNode, project));
      await suite.workflowStorageBackend.publishWorkflowProjectWebAppsWithBackend(created.relativePath, [
        {
          uiGraphId: 'release-gate-web-app',
          slug: 'release-gate-web-app',
        },
      ]);
      await suite.workflowStorageBackend.initializeWorkflowStorage();
      const app = express();
      // Model the owned edge's verified development client, not a trusted-client
      // bypass. Spoofed forwarding is covered separately by trusted-clients.test.
      app.use((req, _res, next) => {
        req.headers['x-rivet-proxy-auth'] = getExpectedProxyAuthToken();
        req.headers['x-rivet-client-ip'] = '198.51.100.10';
        next();
      });
      app.use(createApiApp('combined'));
      const listener = await listenTestServer(http.createServer(app));
      try {
        const gate = Object.create(ReusableProviderGate.prototype);
        gate.config = { baseUrl: listener.baseUrl };
        gate.settings = { trustedClients: ['198.51.100.10'] };
        gate.secrets = { rivetKey: values.RIVET_KEY };
        gate.uiCookie = `rivet_ui_token=${getExpectedUiSessionToken()}`;
        gate.operation = {
          startedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7200000).toISOString(),
        };
        const provenance = await gate.verifyClientProvenance();
        assert.equal(provenance.verifiedPublicTestClient, true);
        for (const prefix of ['/apps', '/apps-latest']) {
          const response = await fetch(`${listener.baseUrl}${prefix}/release-gate-web-app`, {
            headers: gate.probeHeaders,
            redirect: 'manual',
          });
          assert.equal(response.status, retainedOAuth ? 401 : 200);
          await response.body?.cancel();
        }
        const projectId = await gate.prepareWebAppAuthentication(listener.baseUrl, created.relativePath);
        assert.ok(projectId);
        for (const prefix of ['/apps', '/apps-latest']) {
          const html = await gate.readWebAppHtml(listener.baseUrl, `${prefix}/release-gate-web-app`);
          const action = await gate.requestWorkflow(listener.baseUrl, `${prefix}/release-gate-web-app/actions/run`, {
            method: 'POST',
            body: JSON.stringify({
              componentId: WEB_APP_TEST_ACTION_COMPONENT_ID,
              revisionKey: extractWebAppRevisionKey(html),
              state: { prompt: 'authenticated fixture' },
            }),
          });
          assert.ok(action);
          const denied = await fetch(`${listener.baseUrl}${prefix}/release-gate-web-app`, {
            headers: gate.probeHeaders,
          });
          assert.equal(denied.status, 401, 'editor authentication must not bypass web-app OAuth');
          await denied.body?.cancel();
        }
        // A real persisted trusted-client policy is a separate, intentional
        // bypass; the dummy-provider development allowlist above is not one.
        await writeTrustedClientSettings({ trustedClients: ['198.51.100.10'] });
        const trusted = await fetch(`${listener.baseUrl}/apps/release-gate-web-app`);
        assert.equal(trusted.status, 200);
        await trusted.body?.cancel();
      } finally {
        await listener.close();
      }
    };
    await run();
  });
}
