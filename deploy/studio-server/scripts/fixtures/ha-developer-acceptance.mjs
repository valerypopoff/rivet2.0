// Only exec'd inside the exact isolated backend by the provider qualification.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import WebSocket from 'ws';
import { requestBackendRetirement } from '/opt/rivet/retire-backend.mjs';

assert.equal(process.env.RIVET_POD_UID, process.argv[2]);
const identity = () => requestBackendRetirement(process.env.RIVET_ROLLING_RETIREMENT_SOCKET);
assert.equal((await identity()).incarnation, process.argv[3]);
const headers = {
  'x-rivet-proxy-auth': createHash('sha256')
    .update(process.env.RIVET_KEY + ':proxy-auth')
    .digest('hex'),
  cookie:
    'rivet_ui_token=' +
    createHash('sha256')
      .update(process.env.RIVET_KEY + ':ui-session')
      .digest('hex'),
};
const base = 'http://127.0.0.1:' + process.env.PORT;
const read = async (route) => {
  const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(10000), redirect: 'error' });
  assert.equal(response.status, 200);
  return response.json();
};
await read('/api/workflows/tree');
const projectPath = process.argv[4];
if (projectPath) {
  assert.match(projectPath, /^\/managed\/workflows\/online-editor-save-[a-f0-9-]{36}\.rivet-project$/);
  const post = async (route, body) => {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const loaded = await post('/api/projects/load', { path: projectPath });
  assert.ok(loaded.revisionId);
  const project = parse(loaded.contents);
  const marker = randomUUID();
  project.data.metadata.description = marker;
  const saved = await post('/api/projects/save', {
    path: projectPath,
    contents: stringify(project),
    datasetsContents: loaded.datasetsContents,
    expectedRevisionId: loaded.revisionId,
    projectId: project.data.metadata.id,
    saveIntent: 'in-place',
  });
  const reopened = await post('/api/projects/load', { path: projectPath });
  assert.equal(reopened.revisionId, saved.revisionId);
  assert.equal(parse(reopened.contents).data.metadata.description, marker);
}
const config = await read('/api/config');
const url = new URL(config.executorWsUrl);
url.host = '127.0.0.1:' + process.env.PORT;
await new Promise((resolve, reject) => {
  const socket = new WebSocket(url, ['rivet-session-v1'], { headers });
  const timer = setTimeout(() => {
    socket.terminate();
    reject(Error('Editor acceptance timed out'));
  }, 10000);
  const finish = (error) => {
    clearTimeout(timer);
    socket.close();
    if (error) reject(error);
    else resolve();
  };
  socket.once('error', finish);
  socket.on('message', (raw) => {
    try {
      if (JSON.parse(raw).message === 'executor-session-ready') finish();
    } catch (e) {
      finish(e);
    }
  });
});
assert.equal((await identity()).incarnation, process.argv[3]);
console.log(
  JSON.stringify({
    podUid: process.env.RIVET_POD_UID,
    incarnation: process.argv[3],
    developerApi: true,
    ...(projectPath ? { projectSave: true } : {}),
    editorSession: true,
  }),
);
