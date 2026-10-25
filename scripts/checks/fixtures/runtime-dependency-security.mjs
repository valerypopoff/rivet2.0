import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

const consumer = (workspace) => createRequire(new URL(`../../../packages/${workspace}/package.json`, import.meta.url));
const api = consumer('studio-server-api');
const web = consumer('studio-server-web');
const node = consumer('node');
const google = createRequire(web.resolve('@google/genai'));
const vector = process.argv[2];
assert.ok(['body-parser', 'undici', 'zod', 'google-sdk'].includes(vector));

async function serving(handler, run) {
  const server = createServer(handler);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

if (vector === 'body-parser') {
  const docs = consumer('docs');
  const docusaurus = createRequire(docs.resolve('@docusaurus/core/package.json'));
  const webpack = createRequire(docusaurus.resolve('webpack-dev-server/package.json'));
  for (const parent of [api, webpack]) {
    const express = parent('express');
    const bodyParser = createRequire(parent.resolve('express'))('body-parser');
    const app = express();
    app.use(bodyParser.json());
    app.post('/', (req, res) => res.json(req.body));
    app.use((error, _req, res, _next) => res.status(error.status || 500).end());
    await serving(app, async (url) => {
      const compressed = gzipSync(Buffer.from('{"ok":true}'));
      const send = (body) =>
        new Promise((resolve, reject) => {
          const req = request(
            url,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-encoding': 'gzip',
                'content-length': body.length,
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('error', reject);
              res.on('end', () => resolve({ status: res.statusCode, text }));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      for (let i = 0; i < 3; i++) {
        const malformed = await send(Buffer.concat([compressed, Buffer.from('trailing garbage')]));
        assert.ok([200, 400].includes(malformed.status));
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(await send(compressed), { status: 200, text: '{"ok":true}' });
      }
    });
  }
}

if (vector === 'undici') {
  const search = createRequire(consumer('docs').resolve('@easyops-cn/docusaurus-search-local'));
  const cheerio = createRequire(search.resolve('cheerio'));
  for (const parent of [consumer('studio-server-bootstrap'), cheerio]) {
    const { fetch } = parent('undici');
    await serving(
      (req, res) => {
        if (req.url === '/bad') {
          res.writeHead(200, { 'content-encoding': Array(6).fill('gzip').join(', '), 'content-length': '100' });
          res.flushHeaders();
          setImmediate(() => res.destroy());
        } else res.end('healthy');
      },
      async (url) => {
        for (let i = 0; i < 3; i++) {
          await assert.rejects(fetch(`${url}/bad`));
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(await (await fetch(url)).text(), 'healthy');
        }
      },
    );
  }
}

if (vector === 'zod') {
  const mcp = createRequire(node.resolve('@modelcontextprotocol/sdk/client/index.js'));
  for (const parent of [consumer('app'), consumer('core'), api, web, mcp, google]) {
    const { z } = parent('zod');
    let parsed = 0;
    const item = z.string().refine(() => {
      parsed++;
      return true;
    });
    const cases = [
      [z.array(item).max(2), [1, 2, 3], ['a']],
      [z.array(item).length(2), [1, 2, 3], ['a', 'b']],
      [z.set(item).max(2), new Set([1, 2, 3]), new Set(['a'])],
      [
        z.map(item, item).max(2),
        new Map([
          [1, 1],
          [2, 2],
          [3, 3],
        ]),
        new Map([['a', 'b']]),
      ],
    ];
    for (const [schema, oversized, ordinary] of cases) {
      const result = schema.safeParse(oversized);
      assert.equal(result.success, false);
      assert.equal(result.error.issues.length, 1);
      assert.equal(result.error.issues[0].code, 'too_big');
      assert.equal(parsed, 0, 'upper size checks must reject before walking elements');
      assert.deepEqual(schema.parse(ordinary), ordinary);
      assert.ok(parsed > 0);
      parsed = 0;
    }
  }
}

if (vector === 'google-sdk') {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].text, 'fixture prompt');
    assert.equal(body.tools[0].functionDeclarations[0].name, 'fixture_tool');
    return new Response(
      JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'fixture output' }] } }] }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  try {
    const { GoogleGenAI } = web('@google/genai');
    const sdk = new GoogleGenAI({ apiKey: 'fixture-only' });
    const response = await sdk.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: 'fixture prompt',
      config: {
        tools: [
          {
            functionDeclarations: [
              { name: 'fixture_tool', parameters: { type: 'OBJECT', properties: { value: { type: 'STRING' } } } },
            ],
          },
        ],
      },
    });
    assert.equal(response.text, 'fixture output');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
