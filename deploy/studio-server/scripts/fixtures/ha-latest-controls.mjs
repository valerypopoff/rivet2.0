// Self-contained because the editor probe imports these exact bytes over stdin
// inside both predecessor and candidate images. No dependency on their exports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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
  const sequence = Number(started.rivetEventId?.split(':').at(-1));
  assert.ok(started.rivetEventId?.startsWith(`${owner}:`) && Number.isSafeInteger(sequence) && sequence > 0);
  const keys = ['channel', 'rootRunId', 'projectId', 'owner', 'incarnation'];
  let target;
  if (managed) {
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
      return managed
        ? keys.every((key) => frame.rivetScope?.[key] === target[key])
        : frame.rivetEventId?.startsWith(`${owner}:`) && Number(frame.rivetEventId.split(':').at(-1)) >= sequence;
    },
    async send(action) {
      assert.ok(action === 'pause' || action === 'resume', 'Unsupported retirement probe control');
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
      assert.equal(result.data.status, 'accepted', `Latest ${action} was not acknowledged; no command was retried`);
    },
  };
}
