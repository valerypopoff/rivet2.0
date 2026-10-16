import { randomUUID } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Supervisor-local, non-interrupting retirement. No deadline here can kill accepted work. */
export function createBackendRetirement({
  incarnation = randomUUID(),
  api,
  executor,
  available,
  wait = () => new Promise((resolve) => setTimeout(resolve, 250)),
  onRetiring = () => {},
}) {
  let state = 'serving';
  let operationId = null;
  let completion;
  const snapshot = () => ({ protocol: 1, withdrawalProtocol: 1, incarnation, operationId, state });
  function validate(status, expectedOperation) {
    if (
      !status ||
      status.protocol !== 1 ||
      status.incarnation !== incarnation ||
      status.operationId !== expectedOperation ||
      !['serving', 'withdrawing', 'draining', 'drained', 'failed'].includes(status.state)
    )
      throw new Error('Retirement acknowledgement identity is unavailable or incompatible.');
    if (status.state === 'failed') throw new Error('Participant retirement failed; replacement is blocked.');
    return status;
  }
  async function drainParticipant(participant) {
    await participant.begin(operationId, incarnation);
    while (true) {
      const status = validate(await participant.status(), operationId);
      if (status.state === 'drained') return;
      if (status.state !== 'draining') throw new Error('Retirement fence is unconfirmed.');
      await wait();
    }
  }
  const drain = async () => {
    state = 'draining';
    await drainParticipant(executor);
    await drainParticipant(api);
    if (!available()) throw new Error('Participant ownership was lost during retirement.');
    state = 'drained';
  };
  const start = (id, expectedIncarnation, withdrawOnly) => {
    if (!UUID.test(id ?? '') || expectedIncarnation !== incarnation)
      throw new Error('Retirement operation identity rejected.');
    if (operationId) {
      if (id !== operationId) throw new Error('Another retirement operation owns this backend.');
      if (!withdrawOnly && state === 'withdrawing')
        completion = drain().catch(() => {
          state = 'failed';
        });
      return snapshot();
    }
    if (!available()) throw new Error('Backend is not ready for planned retirement.');
    operationId = id;
    state = 'checking';
    completion = (async () => {
      // Establish both capabilities before asking either participant to retire.
      for (const participant of [api, executor]) {
        const status = validate(await participant.status(), null);
        if (status.state !== 'serving') throw new Error('Participant is not serving.');
        if (withdrawOnly && participant === api && status.withdrawalProtocol !== 1)
          throw new Error('API cannot withdraw routing before admission fencing.');
      }
      if (!available()) throw new Error('Participant ownership changed during retirement preflight.');
      // A rejected capability check must not withdraw a healthy serving pod.
      onRetiring();
      if (withdrawOnly) {
        const status = validate(await api.withdraw(operationId, incarnation), operationId);
        if (status.state !== 'withdrawing') throw new Error('API routing withdrawal is unconfirmed.');
        state = 'withdrawing';
      } else await drain();
    })().catch(() => {
      state = 'failed';
    });
    return snapshot();
  };
  return {
    snapshot,
    withdraw: (id, expectedIncarnation) => start(id, expectedIncarnation, true),
    begin: (id, expectedIncarnation) => start(id, expectedIncarnation, false),
    async wait() {
      await completion;
      return snapshot();
    },
  };
}

export function createApiRetirementParticipant(url, token) {
  async function request(method, body) {
    const response = await fetch(url, {
      method,
      headers: { 'x-rivet-retirement-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('API retirement acknowledgement failed.');
    return response.json();
  }
  return {
    status: () => request('GET'),
    // The begin command is sent once. A lost acknowledgement blocks replacement,
    // never restarts the operation or replays unrelated writes.
    begin: (operationId, incarnation) => request('POST', { protocol: 1, operationId, incarnation }),
    withdraw: (operationId, incarnation) =>
      request('POST', { protocol: 1, action: 'withdraw', operationId, incarnation }),
  };
}

export function createExecutorRetirementParticipant(getChild, incarnation) {
  async function request(type, operationId) {
    const child = getChild();
    if (!child?.connected || child.exitCode != null || child.signalCode != null)
      throw new Error('Executor retirement owner is unavailable.');
    return new Promise((resolve, reject) => {
      const nonce = randomUUID();
      const finish = (error, status) => {
        clearTimeout(timer);
        child.off('message', message);
        child.off('close', closed);
        error ? reject(error) : resolve(status);
      };
      const message = (status) => {
        if (status?.type === 'rivet-retirement-status' && status.nonce === nonce) finish(null, status);
      };
      const closed = () => finish(new Error('Executor retirement owner exited.'));
      const timer = setTimeout(() => finish(new Error('Executor retirement acknowledgement timed out.')), 5000);
      child.on('message', message);
      child.once('close', closed);
      try {
        child.send({ type, protocol: 1, incarnation, operationId, nonce }, (error) => {
          if (error) finish(error);
        });
      } catch (error) {
        finish(error);
      }
    });
  }
  return {
    status: () => request('rivet-retirement-query'),
    begin: (operationId) => request('rivet-retire', operationId),
  };
}
