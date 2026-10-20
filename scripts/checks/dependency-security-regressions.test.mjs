import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Resolve through the actual consumer, not a coincidentally patched root copy.
const apiRequire = createRequire(new URL('../../packages/studio-server-api/package.json', import.meta.url));
const expressRequire = createRequire(apiRequire.resolve('express'));
const proxyaddr = expressRequire('proxy-addr');
const webRequire = createRequire(new URL('../../packages/studio-server-web/package.json', import.meta.url));
const concurrentlyRequire = createRequire(webRequire.resolve('concurrently'));
const shellQuote = concurrentlyRequire('shell-quote');
const docsRequire = createRequire(new URL('../../packages/docs/package.json', import.meta.url));
const docsCoreRequire = createRequire(docsRequire.resolve('@docusaurus/core/package.json'));
const webpackRequire = createRequire(docsCoreRequire.resolve('webpack-dev-server/package.json'));

test('redirects strip array and literal-metacharacter credential headers only across hosts', async (t) => {
  const gentraceRequire = createRequire(webRequire.resolve('@gentrace/core'));
  const axiosRequire = createRequire(gentraceRequire.resolve('axios'));
  const redirects = axiosRequire('follow-redirects');
  const target = createServer((req, res) => res.end(JSON.stringify(req.headers)));
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const source = createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/` });
    res.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(async () => {
    for (const server of [source, target]) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  const credentials = {
    Authorization: 'Bearer fixture-only',
    Cookie: 'session=fixture-only',
    'Proxy-Authorization': 'Basic fixture-only',
    'X-Api^Key': 'caret-secret',
    'X-Token|Secret': 'pipe-secret',
    'X-Public': 'kept',
  };
  const request = (port, headers) =>
    new Promise((resolve, reject) => {
      const req = redirects.http.get(
        {
          hostname: 'localhost',
          port,
          path: '/',
          family: 4,
          headers,
          sensitiveHeaders: ['X-Api^Key', 'X-Token|Secret'],
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Local redirect fixture timed out.')));
    });
  for (const headers of [credentials, Object.entries(credentials).flat()]) {
    const direct = await request(target.address().port, headers);
    for (const [name, value] of Object.entries(credentials)) assert.equal(direct[name.toLowerCase()], value);
    const redirected = await request(source.address().port, headers);
    for (const name of Object.keys(credentials).filter((name) => name !== 'X-Public'))
      assert.equal(redirected[name.toLowerCase()], undefined, `${name} must not cross hosts`);
    assert.equal(redirected['x-public'], 'kept');
  }
});

test('documentation editor launcher rejects unsafe Windows arguments without launching a process', () => {
  const launcher = webpackRequire.resolve('launch-editor');
  const command = webpackRequire(join(dirname(launcher), 'construct-windows-launch-command.js'));
  for (const path of ['C:\\fixture\\%PATH%\\..', 'C:\\fixture\\bad\nname.ts', 'C:\\fixture\\bad\rname.ts'])
    assert.throws(() => command('code.cmd', [path]), /Cannot launch an editor/);
  assert.equal(
    command('code.cmd', ['-g', 'C:\\fixture folder\\[slug].ts:2:3']),
    'code.cmd -g "C:\\fixture folder\\[slug].ts:2:3"',
  );
});

test('desktop and hosted development both resolve the patched Vite 6 line', () => {
  for (const workspace of ['app', 'studio-server-web']) {
    const consumer = createRequire(new URL(`../../packages/${workspace}/package.json`, import.meta.url));
    const [major, minor, patch] = consumer('vite/package.json').version.split('.').map(Number);
    assert.equal(major, 6, 'do not silently combine a security repair with a Vite major migration');
    assert.ok(minor > 4 || (minor === 4 && patch >= 4), 'Vite must include the Windows editor-launch fix');
  }
});

test('concurrently rejects command injection through strings following shell comments', () => {
  for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.throws(() => shellQuote.quote(['echo', 'ok', { comment: 'note' }, `a${terminator}injected;#`]), TypeError);
    // parse() can produce a comment even when # occurs in the middle of a word.
    assert.throws(
      () => shellQuote.quote([...shellQuote.parse('echo http://example.com/#fragment'), `a${terminator}injected;#`]),
      TypeError,
    );
  }
  const tokens = ['echo', 'space in an argument', 'quote\'and"double', '$value; & |'];
  assert.deepEqual(shellQuote.parse(shellQuote.quote(tokens)), tokens);
  assert.equal(shellQuote.quote(['echo', { comment: 'note' }, 'ordinary text']), "echo #note 'ordinary text'");
});

test('Express proxy trust rejects IPv4 matches against short mapped/zero-leading IPv6 prefixes', () => {
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    const trust = proxyaddr.compile(subnet);
    for (const address of ['10.0.0.1', '203.0.113.1', '::ffff:203.0.113.1']) {
      assert.equal(trust(address), false, `${subnet} must not trust ${address}`);
    }
    const request = { socket: { remoteAddress: '203.0.113.1' }, headers: { 'x-forwarded-for': '10.0.0.1' } };
    assert.equal(proxyaddr(request, trust), '203.0.113.1');
  }
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    const trust = proxyaddr.compile(subnet);
    for (const address of ['10.0.0.1', '::ffff:10.0.0.1']) assert.equal(trust(address), true);
    for (const address of ['11.0.0.1', '::ffff:11.0.0.1']) assert.equal(trust(address), false);
  }
});

for (const vector of ['env', 'execArgv', 'filename']) {
  test(`Docusaurus workers ignore inherited ${vector} and remain usable`, () => {
    // Prototype mutation is confined to a disposable child. A timeout bounds
    // regressions; neither the test runner nor another test can be polluted.
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/tinypool-security.mjs', import.meta.url)), vector],
      {
        timeout: 15_000,
        stdio: 'pipe',
      },
    );
  });
}

for (const vector of ['braces', 'http-cache', 'image-size']) {
  test(`build tool consumers reject malicious ${vector} input and preserve ordinary behavior`, () => {
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/dependency-parser-security.mjs', import.meta.url)), vector],
      { timeout: 15_000, stdio: 'pipe' },
    );
  });
}
