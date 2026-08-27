import path from 'node:path';

const legacyRoot = process.env.RIVET_APP_SETTINGS_LEGACY_ROOT?.trim();

await import('../app.js');
const {
  disposeAppSettingsRepositories,
  initializeAppSettingsRepositories,
} = await import('../app-settings/settings-repository.js');

try {
  await initializeAppSettingsRepositories();
  console.log(
    '[app-settings] Managed settings are initialized' +
    (legacyRoot ? ` with per-domain legacy fallback from ${path.resolve(legacyRoot)}.` : '.'),
  );
} finally {
  await disposeAppSettingsRepositories();
}
