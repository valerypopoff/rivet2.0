import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';
import { createRivetViteConfig } from '../vite.config.js';
import { VertexAI } from '../src/utils/browser/vertexAiBrowserStub.js';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const coreRoot = resolve(fileURLToPath(new URL('../../core/', import.meta.url)));

test('standalone app keeps Vertex credentials behind its browser-only stub', () => {
  assert.throws(
    () => new VertexAI(),
    new Error('Google Vertex AI credential-based execution is not supported in browser builds. Use a Google API key instead.'),
  );

  const config = createRivetViteConfig({ reactDevTools: false });
  const aliases = Array.isArray(config.resolve?.alias) ? config.resolve.alias : [];
  const vertexAlias = aliases.find(
    (candidate): candidate is { find: string; replacement: string } =>
      typeof candidate === 'object' && candidate.find === '@google-cloud/vertexai',
  );
  assert.equal(vertexAlias?.replacement, resolve(appRoot, 'src/utils/browser/vertexAiBrowserStub.ts'));
});

test('Core continues to resolve the real Vertex package outside the browser alias', () => {
  const coreRequire = createRequire(resolve(coreRoot, 'package.json'));
  const resolvedVertex = coreRequire.resolve('@google-cloud/vertexai').replace(/\\/g, '/');

  assert.match(resolvedVertex, /@google-cloud\/vertexai/);
  assert.doesNotMatch(resolvedVertex, /vertexAiBrowserStub/);
});
