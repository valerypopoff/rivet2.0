// Self-contained because the editor probe imports these exact bytes over stdin
// inside both predecessor and candidate images. No dependency on their exports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// This function is also serialized into disposable Code nodes. Keep it
// self-contained; production workflows and debugger authorization are unchanged.
export async function waitForHaLatestRelease(value, fs, directory = '/tmp', timeoutMs = 20000) {
  // HTTP workflow input is the complete JSON body. A string Graph Input
  // serializes that object before this Code node receives it.
  if (typeof value === 'string' && value.startsWith('{')) {
    try {
      value = JSON.parse(value).input;
    } catch {
      return;
    }
  }
  const match = typeof value === 'string' && /^ha-latest-(rivet-ha-probe-[a-f0-9-]{36}\.json)$/.exec(value);
  if (!match) return;
  const file = `${directory}/${match[1]}.latest`;
  await fs.promises.writeFile(file + '.waiting', value, { flag: 'wx' });
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file + '.release')) {
    if (Date.now() >= deadline) throw Error('Latest retirement probe was not released before its deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await fs.promises.unlink(file + '.release');
  await fs.promises.unlink(file + '.waiting');
}

export function withHaLatestAdmission(nodes) {
  const input = Object.values(nodes).filter((node) => node.data?.id === 'input' && node.outgoingConnections);
  assert.equal(input.length, 1, 'Latest probe requires one input node');
  assert.ok(!nodes['[latest-admission]:code "Latest admission"']);
  const outgoing = input[0].outgoingConnections;
  assert.ok(outgoing.every((connection) => connection.startsWith('data->')));
  input[0].outgoingConnections = ['data->"Latest admission" latest-admission/input'];
  nodes['[latest-admission]:code "Latest admission"'] = {
    data: {
      inputNames: ['input'],
      outputNames: ['output'],
      code: `await (${waitForHaLatestRelease.toString()})(inputs.input.value,require('node:fs'),require('node:os').tmpdir());
return {output:{type:'string',value:inputs.input.value}};`,
    },
    outgoingConnections: outgoing.map((connection) => connection.replace(/^data->/, 'output->')),
    visualData: '90/150/300/null//',
  };
  return nodes;
}

export function assertHaLatestSession(session) {
  assert.equal(session?.message, 'latest-session', 'Missing latest-debugger handshake');
  assert.ok(session.data?.protocol === 1 || session.data?.protocol === 2, 'Unsupported latest-debugger protocol');
  if (session.data.protocol === 2) {
    assert.equal(session.data.channel, null, 'The retirement probe subscribes only to the default channel');
    assert.equal(session.data.channelIsolation, true);
    assert.equal(session.data.runScopedControls, true);
  }
}

export function createHaLatestRunControls({ session, started, owner, socket, observations, waitFor }) {
  assertHaLatestSession(session);
  const managed = session.data.protocol === 2;
  const scoped = managed || started.rivetScope !== undefined;
  const controllable = managed ? started.rivetLegacyOwner !== true : !scoped;
  const sequence = Number(started.rivetEventId?.split(':').at(-1));
  assert.ok(started.rivetEventId?.startsWith(`${owner}:`) && Number.isSafeInteger(sequence) && sequence > 0);
  const keys = ['channel', 'rootRunId', 'projectId', 'owner', 'incarnation'];
  let target;
  if (scoped) {
    const scope = started.rivetScope;
    assert.equal(scope?.channel, null);
    assert.equal(scope?.owner, owner);
    for (const key of keys.slice(1))
      assert.ok(typeof scope[key] === 'string' && scope[key].length > 0 && scope[key].length <= 200);
    assert.equal(started.data?.execution?.rootRunId, scope.rootRunId);
    assert.equal(started.data?.project?.metadata?.id, scope.projectId);
    assert.ok(started.rivetEventId.startsWith(`${owner}:${scope.incarnation}:`));
    target = Object.freeze(Object.fromEntries(keys.map((key) => [key, scope[key]])));
  }
  return {
    matches(frame) {
      return scoped
        ? keys.every((key) => frame.rivetScope?.[key] === target[key])
        : frame.rivetEventId?.startsWith(`${owner}:`) && Number(frame.rivetEventId.split(':').at(-1)) >= sequence;
    },
    async send(action) {
      assert.ok(action === 'pause' || action === 'resume', 'Unsupported retirement probe control');
      assert.ok(controllable, 'Mixed-version latest observation is read-only; no legacy control fallback');
      if (!managed) {
        // Only an explicitly negotiated predecessor v1 may use its legacy path.
        socket.send(JSON.stringify({ type: action }));
        return;
      }
      const commandId = randomUUID();
      socket.send(JSON.stringify({ type: 'latest-control', data: { commandId, target, action } }));
      const result = await waitFor(`remote latest ${action} acknowledgement`, () =>
        observations.find((frame) => frame.message === 'latest-control-result' && frame.data?.commandId === commandId),
      );
      assert.equal(
        result.data.status,
        'accepted',
        `Latest ${action} was not acknowledged (${String(result.data.reason ?? 'no reason').slice(0, 200)}); no command was retried`,
      );
    },
  };
}
