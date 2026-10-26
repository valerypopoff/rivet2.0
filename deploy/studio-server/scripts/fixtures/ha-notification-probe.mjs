import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const neighbor = process.argv[2];
if (!/^[a-z0-9-]+$/.test(neighbor ?? '')) throw Error('Invalid notification probe peer');
const folderOnly = process.argv[3] === 'folders';
if (process.argv[3] && !folderOnly) throw Error('Invalid notification probe workload');
const local = `http://127.0.0.1:${process.env.PORT}`;
const peer = `http://${neighbor}.${process.env.RIVET_HA_HEADLESS_SERVICE}:${process.env.PORT}`;
const headers = {
  'x-rivet-proxy-auth': createHash('sha256').update(`${process.env.RIVET_KEY}:proxy-auth`).digest('hex'),
  cookie: `rivet_ui_token=${createHash('sha256').update(`${process.env.RIVET_KEY}:ui-session`).digest('hex')}`,
};
async function until(check) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Cross-owner notification did not arrive');
}
async function json(base, route, body, method) {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? 'GET' : route.endsWith('/library') ? 'PUT' : 'POST'),
    headers: { ...headers, 'content-type': 'application/json', 'X-Rivet-Namespace-Intent': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `Notification probe request failed: ${response.status}`);
  return response.json();
}
async function observe(base, route) {
  const controller = new AbortController(),
    events = [];
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  let error;
  let response;
  try {
    response = await fetch(base + route, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
  } catch (caught) {
    clearTimeout(timer);
    controller.abort();
    throw caught;
  }
  const task = (async () => {
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 65536 || events.length > 128) throw Error('Notification probe exceeded bounds');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1],
          data = /^data: (.+)$/m.exec(frame)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })().catch((caught) => {
    if (!controller.signal.aborted) error = caught;
  });
  const wait = (check) =>
    until(() => {
      if (error) throw error;
      return check(events);
    });
  try {
    await wait((e) => e.length > 0);
  } catch (caught) {
    clearTimeout(timer);
    controller.abort();
    await task;
    throw caught;
  }
  return {
    events,
    wait,
    async close() {
      clearTimeout(timer);
      controller.abort();
      await task;
    },
  };
}
const directions = [];
for (const [origin, observer, direction] of [
  [local, peer, 'local-to-peer'],
  [peer, local, 'peer-to-local'],
]) {
  const tree = await observe(observer, '/api/workflows/tree/events');
  let library;
  try {
    library = await observe(observer, '/api/workflows/evaluation-runs/library/events');
    const revision = tree.events[0].data.revision;
    // The predecessor can predate the empty-folder notification fix. Project
    // creation exercises the common old/new contract; the final candidate pair
    // separately exercises empty folders after every original owner is replaced.
    const name = `ha-notification-${randomUUID()}`;
    const created = await json(origin, `/api/workflows/${folderOnly ? 'folders' : 'projects'}`, {
      name,
      mutation: {
        operationId: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        expectedDestinationId: null,
      },
      ...(folderOnly ? { parentRelativePath: '' } : { folderRelativePath: '' }),
    });
    if (!folderOnly) {
      if (created.project.namespaceProtocol === 1) {
        await json(origin, '/api/workflows/namespace/mutate', {
          operationId: randomUUID(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          command: {
            kind: 'rename',
            itemType: 'project',
            relativePath: created.project.relativePath,
            name: `${name}-renamed`,
          },
          expectedSource: { id: created.project.projectMetadataId, revisionId: created.project.revisionId },
        });
      } else
        await json(
          origin,
          '/api/workflows/projects',
          {
            relativePath: created.project.relativePath,
            newName: `${name}-renamed`,
          },
          'PATCH',
        );
    }
    await tree.wait((events) => events.some((e) => e.event === 'tree-changed' && e.data.revision > revision));
    const before = await json(origin, '/api/workflows/evaluation-runs/library'),
      marker = randomUUID();
    before.library.migratedLegacyProjectIds.push(marker);
    const after = await json(origin, '/api/workflows/evaluation-runs/library', {
      expectedRevision: before.revision,
      library: before.library,
    });
    assert.ok(after.revision > before.revision);
    await library.wait((events) =>
      events.some((e) => e.event === 'library-changed' && e.data.revision === after.revision),
    );
    const observed = await json(observer, '/api/workflows/evaluation-runs/library');
    assert.ok(observed.library.migratedLegacyProjectIds.includes(marker));
    directions.push({ direction, tree: true, library: true, revision: after.revision });
  } finally {
    await tree.close();
    await library?.close();
  }
}
console.log(JSON.stringify({ pod: process.env.RIVET_POD_NAME, neighbor, directions }));
