// Test-only compatibility for creating/exporting old storage formats. Never
// selected by a server launcher or shipped as an image entry point.
export function legacyServingFixtureEntrypoint(source) {
  const current = 'exec node /app/packages/studio-server-api/dist/studio-server-api/src/serve.js';
  if (!source.includes(current))
    throw new Error('API entry point changed; reassess the legacy fixture before running it.');
  return source
    .replace(/\r\n/g, '\n')
    .replace(/^NODE_OPTIONS= node .*server-deployment-contract.*\r?\n/m, '')
    .replace(current, 'exec node /app/packages/studio-server-api/dist/studio-server-api/src/server.js');
}
