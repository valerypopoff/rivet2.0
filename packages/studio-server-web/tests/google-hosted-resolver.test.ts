import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer, loadConfigFromFile, normalizePath, type ViteDevServer } from 'vite';
import { isNodeBuiltinModuleId } from '../vite.config.js';

const viteConfigPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const coreRoot = resolve(fileURLToPath(new URL('../../core/', import.meta.url)));
const hostedGoogleAdapter = resolve(
  fileURLToPath(new URL('../overrides/core/plugins/google/google.ts', import.meta.url)),
);

async function withHostedViteServer<T>(action: (server: ViteDevServer) => Promise<T>): Promise<T> {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, viteConfigPath);
  assert.ok(loaded?.config, 'hosted Vite configuration should load');

  const server = await createServer({
    ...loaded.config,
    configFile: false,
    clearScreen: false,
    logLevel: 'error',
    server: {
      ...loaded.config.server,
      middlewareMode: true,
    },
  });

  try {
    return await action(server);
  } finally {
    await server.close();
  }
}

async function resolveFrom(server: ViteDevServer, source: string, importer: string): Promise<string> {
  const resolved = await server.pluginContainer.resolveId(source, importer);
  assert.ok(resolved, `Expected ${source} to resolve from ${importer}`);
  return normalizePath(resolved.id);
}

test('hosted Vite redirects only the legacy Google node to its browser adapter', async () => {
  await withHostedViteServer(async (server) => {
    const chatGoogleNode = resolve(coreRoot, 'src/plugins/google/nodes/ChatGoogleNode.ts');
    const modelRegistry = resolve(coreRoot, 'src/model/chat-v2/modelRegistry.ts');
    const adapter = normalizePath(hostedGoogleAdapter);

    assert.equal(await resolveFrom(server, '../google.js', chatGoogleNode), adapter);
    assert.equal(await resolveFrom(server, '../google.ts', chatGoogleNode), adapter);
    assert.equal(
      await resolveFrom(server, '../../plugins/google/google.js', modelRegistry),
      normalizePath(resolve(coreRoot, 'src/plugins/google/google.ts')),
    );
    assert.equal(
      await resolveFrom(server, '../../../../../core/src/plugins/google/googleGenerativeAi.js', hostedGoogleAdapter),
      normalizePath(resolve(coreRoot, 'src/plugins/google/googleGenerativeAi.ts')),
    );
  });
});

test('hosted Vite resolves the browser GenAI entry without broad Google rewrites', async () => {
  await withHostedViteServer(async (server) => {
    const leaf = resolve(coreRoot, 'src/plugins/google/googleGenerativeAi.ts');
    const modelRegistry = resolve(coreRoot, 'src/model/chat-v2/modelRegistry.ts');
    const genAiEntry = await resolveFrom(server, '@google/genai', leaf);

    // Dev mode serves the wrapper SDK through Vite's dependency cache. The
    // production build audit separately records its underlying web entry.
    assert.match(genAiEntry, /studio-server-web\/node_modules\/\.vite\/deps\/@google_genai\.js/);
    assert.equal(
      await resolveFrom(server, '@google-cloud/vertexai', modelRegistry),
      normalizePath(resolve(fileURLToPath(new URL('../shims/google-cloud-vertexai.ts', import.meta.url)))),
    );
  });
});

test('hosted Google dependency audit rejects direct and Vite-externalized Node built-ins', () => {
  assert.equal(isNodeBuiltinModuleId('node:fs'), true);
  assert.equal(isNodeBuiltinModuleId('fs/promises'), true);
  assert.equal(isNodeBuiltinModuleId('__vite-browser-external:node:crypto'), true);
  assert.equal(isNodeBuiltinModuleId('__vite-browser-external:stream'), true);
  assert.equal(isNodeBuiltinModuleId('/workspace/packages/core/src/plugins/google/googleGenerativeAi.ts'), false);
});
