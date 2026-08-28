import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

function read(name) {
  const value = env[name]?.trim();
  return value ? value : '';
}

function bool(name, fallback = false) {
  const value = read(name).toLowerCase();
  if (!value) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function getAppDataRoot() {
  return path.resolve(read('RIVET_APP_DATA_ROOT') || '/data/rivet-app');
}

function encodePart(value) {
  return encodeURIComponent(value);
}

function buildDatabaseConnectionString() {
  const explicit = read('RIVET_DEPLOYMENT_DATABASE_CONNECTION_STRING');
  if (explicit) {
    return explicit;
  }

  const host = read('RIVET_DEPLOYMENT_DATABASE_HOST');
  const port = read('RIVET_DEPLOYMENT_DATABASE_PORT') || '5432';
  const database = read('RIVET_DEPLOYMENT_DATABASE_NAME');
  const username = read('RIVET_DEPLOYMENT_DATABASE_USERNAME');
  const password = env.RIVET_DEPLOYMENT_DATABASE_PASSWORD ?? '';

  if (!host && !database && !username && !password) {
    return '';
  }

  const missing = [
    !host ? 'database host' : null,
    !database ? 'database name' : null,
    !username ? 'database username' : null,
    password === '' ? 'database password' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Cannot build deployment storage database connection string; missing ${missing.join(', ')}`);
  }

  return `postgresql://${encodePart(username)}:${encodePart(password)}@${host}:${port}/${encodePart(database)}`;
}

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

function buildStorageUrl() {
  const explicit = read('RIVET_DEPLOYMENT_STORAGE_URL');
  if (explicit) {
    return explicit;
  }

  const bucket = read('RIVET_DEPLOYMENT_STORAGE_BUCKET');
  if (!bucket) {
    return '';
  }

  const region = read('RIVET_DEPLOYMENT_STORAGE_REGION') || 'us-east-1';
  const endpoint = normalizeEndpoint(read('RIVET_DEPLOYMENT_STORAGE_ENDPOINT'));
  const forcePathStyle = bool('RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE');

  if (forcePathStyle) {
    const baseEndpoint = endpoint || `https://s3.${region}.amazonaws.com`;
    return `${baseEndpoint}/${bucket}`;
  }

  if (endpoint) {
    const url = new URL(endpoint);
    return `${url.protocol}//${bucket}.${url.host}`;
  }

  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function getSettingsPath() {
  return path.join(getAppDataRoot(), 'settings', 'deployment-storage.json');
}

function getSettings() {
  const storageMode = read('RIVET_DEPLOYMENT_STORAGE_MODE') || 'managed';
  const databaseMode = read('RIVET_DEPLOYMENT_DATABASE_MODE') || 'managed';
  const databaseConnectionString = buildDatabaseConnectionString();
  const storageUrl = buildStorageUrl();

  return {
    version: 1,
    storageMode,
    artifactsHostPath: read('RIVET_DEPLOYMENT_ARTIFACTS_HOST_PATH') || '../',
    databaseMode,
    databaseSslMode: read('RIVET_DEPLOYMENT_DATABASE_SSL_MODE') || (databaseMode === 'local-docker' ? 'disable' : 'require'),
    databaseConnectionString,
    storageUrl,
    storageAccessKeyId: read('RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID'),
    storageAccessKey: read('RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY'),
    updatedAt: new Date().toISOString(),
  };
}

function validateSettings(settings) {
  if (settings.storageMode !== 'managed') {
    return;
  }

  const missing = [
    !settings.databaseConnectionString ? 'database connection string' : null,
    !settings.storageUrl ? 'object storage URL' : null,
    !settings.storageAccessKeyId ? 'object storage access key ID' : null,
    !settings.storageAccessKey ? 'object storage secret access key' : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(`Cannot bootstrap managed deployment storage settings; missing ${missing.join(', ')}`);
  }
}

const settingsPath = getSettingsPath();
const shouldOverwrite = bool('RIVET_DEPLOYMENT_STORAGE_SETTINGS_OVERWRITE');

if (fs.existsSync(settingsPath) && !shouldOverwrite) {
  console.log(`[deployment-storage] Keeping existing app settings at ${settingsPath}`);
  process.exit(0);
}

const settings = getSettings();
validateSettings(settings);

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`[deployment-storage] Wrote app settings to ${settingsPath}`);
