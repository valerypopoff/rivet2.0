import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// A stalled import or idle pass must fail here, rather than consume the
// publication command's much longer build/scan timeout.
const watchdog = setTimeout(() => {
  console.error('Packaged janitor probe exceeded its 10-second deadline');
  process.exit(1);
}, 10000);
try {
  // Runs the real mounted bundle with an empty synthetic operation inventory.
  // No cloud credentials, production settings or toolchain are mounted.
  const WebSocket = createRequire('/app/packages/studio-server-api/package.json')('ws');
  assert.equal(typeof WebSocket, 'function');
  const { stagingJanitorPass } = await import(process.argv[2]);
  const settings = { clusterUid: 'startup-cluster', controlNamespace: 'startup-control' };
  let healthWritten = false;
  const result = await stagingJanitorPass({
    settings,
    owner: { name: 'startup-janitor', uid: 'startup-owner' },
    cloud: { project: async () => {} },
    api: {
      json: async (method, route, body) => {
        if (route === '/api/v1/namespaces/kube-system') return { metadata: { uid: settings.clusterUid } };
        if (route.endsWith('/pods/startup-janitor')) return { metadata: { uid: 'startup-owner' } };
        if (method === 'PUT') {
          assert.equal(JSON.parse(body.data.health).podUid, 'startup-owner');
          healthWritten = true;
          return body;
        }
        if (route.endsWith('/rivet-qualification-janitor-health')) return { data: { health: '{}' } };
        if (route.includes('?labelSelector=')) return { items: [] };
        throw new Error('Unexpected janitor startup request');
      },
    },
  });
  assert.equal(healthWritten, true);
  assert.deepEqual(result, []);
  console.log('Packaged janitor dependencies and idle pass passed');
} finally {
  clearTimeout(watchdog);
}
