import assert from 'node:assert/strict';
import test from 'node:test';

import { readRepoFile } from './helpers/repo-contract-helpers.js';

function composeServiceBlock(compose: string, service: string): string {
  const marker = `\n  ${service}:`;
  const markerIndex = compose.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected ${service} service to exist.`);
  const start = markerIndex + 1;
  const afterMarker = start + marker.length - 1;
  const nextService = /\r?\n  [a-z][a-z0-9-]*:/i.exec(compose.slice(afterMarker));
  return compose.slice(start, nextService ? afterMarker + nextService.index : compose.length);
}

test('Docker and Helm expose bounded browser-storage RPC defaults only to API action hosts', () => {
  for (const compose of [
    readRepoFile('deploy/studio-server/compose/docker-compose.yml'),
    readRepoFile('deploy/studio-server/compose/docker-compose.dev.yml'),
  ]) {
    const api = composeServiceBlock(compose, 'api');
    assert.match(
      api,
      /RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_TIMEOUT_MS=\$\{RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_TIMEOUT_MS:-60000\}/,
    );
    assert.match(
      api,
      /RIVET_WEB_APP_BROWSER_STORAGE_MAX_VALUE_BYTES=\$\{RIVET_WEB_APP_BROWSER_STORAGE_MAX_VALUE_BYTES:-268435456\}/,
    );
    assert.match(
      api,
      /RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTION_BYTES=\$\{RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTION_BYTES:-536870912\}/,
    );
    assert.match(
      api,
      /RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTIVE_BYTES=\$\{RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTIVE_BYTES:-536870912\}/,
    );
    for (const service of ['proxy', 'web', 'executor']) {
      assert.doesNotMatch(composeServiceBlock(compose, service), /RIVET_WEB_APP_BROWSER_STORAGE_/);
    }
  }

  const values = readRepoFile('deploy/studio-server/helm/values.yaml');
  assert.match(values, /RIVET_WEB_APP_BROWSER_STORAGE_TRANSFER_TIMEOUT_MS: '60000'/);
  assert.match(values, /RIVET_WEB_APP_BROWSER_STORAGE_MAX_VALUE_BYTES: '268435456'/);
  assert.match(values, /RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTION_BYTES: '536870912'/);
  assert.match(values, /RIVET_WEB_APP_BROWSER_STORAGE_MAX_ACTIVE_BYTES: '536870912'/);
});

test('published web-app WebSockets remain unbuffered, bidirectional, and long-lived for binary transfers', () => {
  const bootstrap = readRepoFile('deploy/studio-server/images/proxy/normalize-workflow-paths.sh');
  const socketBlocks = [...bootstrap.matchAll(/location ~ \^[^\n]+\/actions\/ws\$ \{([\s\S]*?)\n    \}/g)].map(
    (match) => match[1] ?? '',
  );
  assert.equal(socketBlocks.length, 2, 'Expected published and latest web-app WebSocket proxy blocks.');
  for (const [index, upstream] of ['execution', 'api'].entries()) {
    const block = socketBlocks[index]!;
    assert.ok(block.includes(`proxy_pass \\$${upstream}_upstream;`));
    assert.ok(block.includes('proxy_set_header Upgrade \\$http_upgrade;'));
    assert.ok(block.includes('proxy_set_header Connection \\$connection_upgrade;'));
    assert.match(block, /proxy_read_timeout 86400s;/);
    assert.match(block, /proxy_send_timeout 86400s;/);
    assert.match(block, /proxy_buffering off;/);
  }
});
