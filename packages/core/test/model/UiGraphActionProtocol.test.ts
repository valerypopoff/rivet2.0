import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildAgentResponseTrace,
  RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
  isRivetWebAppRunTerminalEvent,
  parseRivetWebAppClientMessage,
  parseRivetWebAppServerMessage,
} from '../../src/index.js';

void describe('UiGraphActionProtocol', () => {
  void it('parses versioned action starts and rejects malformed messages', () => {
    assert.deepEqual(
      parseRivetWebAppClientMessage({
        type: 'action.start',
        componentId: 'button',
        requestId: 'request',
        revisionKey: 'revision',
        state: { prompt: 'Hello' },
        storage: { analysis: 'Summary' },
      }),
      {
        type: 'action.start',
        componentId: 'button',
        requestId: 'request',
        revisionKey: 'revision',
        state: { prompt: 'Hello' },
        storage: { analysis: 'Summary' },
      },
    );
    assert.deepEqual(
      parseRivetWebAppClientMessage({
        type: 'client.hello',
        protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
      }),
      {
        type: 'client.hello',
        protocolVersion: RIVET_WEB_APP_ACTION_PROTOCOL_VERSION,
      },
    );
    assert.equal(parseRivetWebAppClientMessage({ type: 'action.start', requestId: 'request', state: {} }), undefined);
    assert.equal(
      parseRivetWebAppClientMessage({
        type: 'action.start',
        componentId: 'button',
        requestId: 'request',
        state: {},
        storage: [],
      }),
      undefined,
    );
    assert.equal(parseRivetWebAppClientMessage({ type: 'run.resume', runId: 'run', lastSequence: -1 }), undefined);
  });

  void it('normalizes progress reports at the untrusted transport boundary', () => {
    assert.deepEqual(
      parseRivetWebAppServerMessage({
        type: 'action.progress',
        progress: { message: '  Working  ', percent: 150 },
        requestId: 'request',
        runId: 'run',
        sequence: 2,
      }),
      {
        type: 'action.progress',
        progress: { message: 'Working', percent: 100 },
        requestId: 'request',
        runId: 'run',
        sequence: 2,
      },
    );
    assert.equal(
      parseRivetWebAppServerMessage({
        type: 'action.progress',
        progress: {},
        requestId: 'request',
        runId: 'run',
        sequence: 2,
      }),
      undefined,
    );
  });

  void it('parses run-level rejections without treating them as replayable events', () => {
    assert.deepEqual(
      parseRivetWebAppServerMessage({
        type: 'run.rejected',
        runId: 'run',
        error: 'The web app action is unavailable.',
        code: 'run_unavailable',
      }),
      {
        type: 'run.rejected',
        runId: 'run',
        error: 'The web app action is unavailable.',
        code: 'run_unavailable',
      },
    );
    assert.equal(parseRivetWebAppServerMessage({ type: 'run.rejected', runId: '', error: 'Unavailable' }), undefined);
  });

  void it('distinguishes replayable terminal events from intermediate events', () => {
    const responseTrace = buildAgentResponseTrace({
      scope: 'response',
      execution: { graphId: 'graph', graphRunId: 'graph-run', rootRunId: 'root-run' } as never,
      events: [],
      status: 'completed',
    });
    const completed = parseRivetWebAppServerMessage({
      type: 'action.completed',
      requestId: 'request',
      runId: 'run',
      sequence: 3,
      statePatch: { result: 'Done' },
      storagePatch: { analysis: 'Updated' },
      responseTrace,
    });
    const accepted = parseRivetWebAppServerMessage({
      type: 'action.accepted',
      requestId: 'request',
      runId: 'run',
      sequence: 1,
    });

    assert.ok(completed && completed.type === 'action.completed');
    assert.ok(accepted && accepted.type === 'action.accepted');
    assert.equal(isRivetWebAppRunTerminalEvent(completed), true);
    assert.equal(isRivetWebAppRunTerminalEvent(accepted), false);
    assert.deepEqual(completed?.type === 'action.completed' ? completed.responseTrace : undefined, responseTrace);
    for (const invalidOrFutureTrace of [
      { ...responseTrace, messages: ['secret'] },
      { ...responseTrace, schemaVersion: responseTrace.schemaVersion + 1 },
    ]) {
      assert.deepEqual(
        parseRivetWebAppServerMessage({
          type: 'action.completed',
          requestId: 'request',
          runId: 'run',
          sequence: 3,
          statePatch: { result: 'Still valid' },
          responseTrace: invalidOrFutureTrace,
        }),
        {
          type: 'action.completed',
          requestId: 'request',
          runId: 'run',
          sequence: 3,
          statePatch: { result: 'Still valid' },
        },
      );
    }
  });
});
