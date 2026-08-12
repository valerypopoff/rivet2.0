import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserEnvAllowlist, isEnvAllowed, isProtectedBrowserEnvName } from '../security.js';

test('browser environment lookup does not expose arbitrary server runtime credentials', () => {
  assert.equal(isEnvAllowed('OPENAI_API_KEY'), true);
  assert.equal(isEnvAllowed('BILLING_OPENAI_KEY'), false);
  assert.equal(isEnvAllowed('RIVET_KEY'), false);
  assert.equal(isEnvAllowed('OAUTH_CLIENT_SECRET'), false);
  assert.equal(isEnvAllowed('OAUTH_SESSION_SECRET'), false);
  assert.equal(isEnvAllowed('RIVET_DATABASE_CONNECTION_STRING'), false);
  assert.equal(isEnvAllowed('RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY'), false);
  assert.equal(isEnvAllowed('RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY'), false);
  assert.equal(isEnvAllowed('RIVET_WORKFLOWS_LOCAL_DOCKER_POSTGRES_PASSWORD'), false);
});

test('explicit browser allowlist entries cannot override protected server credential names', () => {
  const protectedNames = [
    'RIVET_KEY',
    'OAUTH_SECRET',
    'OAUTH_CLIENT_SECRET',
    'RIVET_SERVER_UI_OAUTH_SESSION_SECRET',
    'RIVET_DATABASE_CONNECTION_STRING',
    'RIVET_WORKFLOWS_DATABASE_URL',
    'RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY',
    'RIVET_K8S_STORAGE_ACCESS_KEY_ID',
    'RIVET_OBJECT_STORAGE_SECRET_ACCESS_KEY',
    'RIVET_WORKFLOWS_LOCAL_DOCKER_POSTGRES_PASSWORD',
    'MY_DATABASE_URL',
    'AWS_SECRET_ACCESS_KEY',
    'SERVICE_ACCOUNT_PRIVATE_KEY',
    'APP_SESSION_SIGNING_KEY',
    'OAUTH_ACCESS_TOKEN',
    'AWS_SESSION_TOKEN',
    'SERVICE_CREDENTIALS',
    'RIVET_KEY_BACKUP',
    'OAUTH_CLIENT_SECRET_JSON',
    'DATABASE_URL_BACKUP',
    'SERVICE_CREDENTIALS_FILE',
    'PGPASSWORD',
    'MYSQL_PWD',
    'MONGODB_URI',
    'REDIS_URL',
    'DB_PASSWORD_BACKUP',
    'rivet_key',
    'oauth_client_secret',
  ];
  const allowlist = createBrowserEnvAllowlist([...protectedNames, 'BILLING_OPENAI_KEY'].join(','));

  assert.equal(allowlist.has('BILLING_OPENAI_KEY'), true);
  for (const name of protectedNames) {
    assert.equal(
      isProtectedBrowserEnvName(name),
      true,
      `${name} must be classified as protected`,
    );
    assert.equal(
      allowlist.has(name),
      false,
      `${name} must remain unavailable to browser JavaScript`,
    );
  }
});

test('protected-name matching does not reject purpose-specific provider API key aliases', () => {
  const allowedNames = [
    'BILLING_OPENAI_KEY',
    'TOKENIZER_API_KEY',
    'SECRETARY_API_KEY',
    'MONGODB_API_KEY',
  ];
  const allowlist = createBrowserEnvAllowlist(allowedNames.join(','));

  for (const name of allowedNames) {
    assert.equal(isProtectedBrowserEnvName(name), false, `${name} must remain eligible for explicit allowlisting`);
    assert.equal(allowlist.has(name), true);
  }
});
