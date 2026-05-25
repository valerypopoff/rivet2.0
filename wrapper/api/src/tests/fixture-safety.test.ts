import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { loadProjectFromString } from '@valerypopoff/rivet2-node';

function getGraphFixturePath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    '.fixtures',
    'graph-fixture.rivet-project',
  );
}

test('graph speed fixture does not contain live secrets or production endpoints', async () => {
  const fixturePath = getGraphFixturePath();
  const fixture = await fs.readFile(fixturePath, 'utf8');

  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/sk-svcacct-[0-9A-Za-z_-]+/, 'OpenAI service-account key'],
    [/AIza(?!-fixture-redacted-)[0-9A-Za-z_-]+/, 'Google API key'],
    [/csk-(?!fixture-redacted-)[0-9a-z]+/i, 'Cerebras API key'],
    [/"x-rivet-proxy-auth":\s*"[a-f0-9]{32,}"/i, 'Rivet proxy auth hash'],
    [/"x-tmp-token":\s*"eyJ[^"]+"/i, 'JWT-shaped temporary token'],
    [/"authorization":\s*"Bearer (?!\{\{apiToken\}\}|fixture-redacted-token)[^"]+"/i, 'raw bearer token'],
    [/litnet\.com/i, 'production Litnet hostname'],
    [/ngrok-free\.app/i, 'temporary ngrok hostname'],
    [/api\.cerebras\.ai/i, 'live Cerebras API hostname'],
    [/api-free\.deepl\.com/i, 'live DeepL API hostname'],
  ];

  for (const [pattern, description] of forbiddenPatterns) {
    assert.doesNotMatch(fixture, pattern, `${description} must stay out of the benchmark fixture`);
  }
});

test('graph speed fixture has a main graph default endpoint payload', async () => {
  const fixture = await fs.readFile(getGraphFixturePath(), 'utf8');
  const project = loadProjectFromString(fixture);
  const mainGraphId = project.metadata.mainGraphId;

  assert.ok(mainGraphId, 'fixture should declare a main graph');
  const mainGraph = project.graphs[mainGraphId];
  assert.ok(mainGraph, 'fixture main graph should exist');

  const inputNode = mainGraph.nodes.find((node) => {
    const data = node.data as { id?: unknown } | undefined;
    return node.type === 'graphInput' && data?.id === 'input';
  });
  assert.ok(inputNode, 'fixture main graph should have Graph Input "input"');

  const defaultConnection = mainGraph.connections.find(
    (connection) => connection.inputNodeId === inputNode.id && connection.inputId === 'default',
  );
  assert.ok(defaultConnection, 'fixture main graph input should be wired to a default payload');

  const defaultPayloadNode = mainGraph.nodes.find((node) => node.id === defaultConnection.outputNodeId);
  assert.ok(defaultPayloadNode, 'fixture default payload source should exist');
  assert.equal(defaultPayloadNode.type, 'object');

  const jsonTemplate = (defaultPayloadNode.data as { jsonTemplate?: unknown } | undefined)?.jsonTemplate;
  assert.ok(typeof jsonTemplate === 'string', 'fixture default payload JSON template should be a string');

  const parsedPayload = JSON.parse(jsonTemplate);
  assert.equal(typeof parsedPayload, 'object');
  assert.notEqual(parsedPayload, null);
});
