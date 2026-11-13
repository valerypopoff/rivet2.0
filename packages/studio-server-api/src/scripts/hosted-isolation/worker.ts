import { parentPort, workerData } from 'node:worker_threads';
import { runPrototypeRoot } from './runtime.js';
import { prototypeFailure, type ParentMessage, type PrototypeDefinition, type WorkerMessage } from './protocol.js';

if (!parentPort) throw new Error('Isolation prototype entry requires a worker thread.');
const port = parentPort;
const definition = workerData as PrototypeDefinition;
let active: { id: number; controller: AbortController } | undefined;
const send = (message: WorkerMessage) => port.postMessage(message);
port.on('message', (message: ParentMessage) => {
  if (message.kind === 'abort') {
    if (active?.id === message.id) active.controller.abort(new Error('Prototype root cancelled.'));
    return;
  }
  if (active) {
    send({ kind: 'fatal', id: message.id, error: prototypeFailure(new Error('Worker already has an active root.')) });
    return;
  }
  const controller = new AbortController();
  active = { id: message.id, controller };
  void runPrototypeRoot(definition, message.request, controller.signal, (event) =>
    send({ kind: 'event', id: message.id, event }),
  ).then(
    (result) => {
      active = undefined;
      send({ kind: 'settled', id: message.id, result });
    },
    (error) => {
      active = undefined;
      send({ kind: 'fatal', id: message.id, error: prototypeFailure(error) });
    },
  );
});
send({ kind: 'ready' });
