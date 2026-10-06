import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Resolve through the actual consumer, not a coincidentally patched root copy.
const apiRequire = createRequire(new URL('../../packages/studio-server-api/package.json', import.meta.url));
const expressRequire = createRequire(apiRequire.resolve('express'));
const proxyaddr = expressRequire('proxy-addr');

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
