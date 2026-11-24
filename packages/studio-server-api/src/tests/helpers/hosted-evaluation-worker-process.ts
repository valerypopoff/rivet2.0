import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function startHostedEvaluationWorker(input: {
  database: string;
  runtime: 'source' | 'compiled';
  hold?: boolean;
}) {
  const entry =
    input.runtime === 'source'
      ? new URL('./hosted-evaluation-worker.mts', import.meta.url)
      : new URL('../../../dist/studio-server-api/src/tests/helpers/hosted-evaluation-worker.mjs', import.meta.url);
  const child = fork(entry, [], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RIVET_'))),
      HOSTED_EVALUATION_TEST_DATABASE: input.database,
      HOSTED_EVALUATION_TEST_HOLD: input.hold ? '1' : '0',
    },
    execArgv:
      input.runtime === 'source' ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [],
    silent: true,
  });
  const events: {
    event: string;
    entry?: string;
    coordinatorEntry?: string;
    pid?: number;
    runId?: string;
    caseId?: string;
  }[] = [];
  let logs = '',
    nextId = 0;
  let requestedExit: 'shutdown' | 'kill' | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: boolean): void; reject(error: Error): void }>();
  child.stdout!.on('data', (chunk) => {
    logs = (logs + chunk).slice(-131072);
  });
  child.stderr!.on('data', (chunk) => {
    logs = (logs + chunk).slice(-131072);
  });
  child.on(
    'message',
    (message: {
      event?: string;
      id?: number;
      result?: boolean;
      error?: string;
      entry?: string;
      coordinatorEntry?: string;
      pid?: number;
      runId?: string;
      caseId?: string;
    }) => {
      if (message.event) events.push({ ...message, event: message.event });
      if (message.id != null) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error));
        else waiter?.resolve(Boolean(message.result));
      }
    },
  );
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      for (const waiter of pending.values())
        waiter.reject(new Error(`Hosted worker exited: ${code}/${signal}\n${logs}`));
      pending.clear();
      resolve({ code, signal });
    });
  });
  // Attach immediately; startup failures must not create an unhandled rejection.
  void exited.catch(() => undefined);
  async function waitFor(check: () => boolean, label: string, timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    while (!check()) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= until)
        throw new Error(`${label}\n${logs}`);
      await delay(10);
    }
  }
  function command(command: 'start' | 'release' | 'retire' | 'shutdown') {
    if (command === 'shutdown' && child.connected) requestedExit ??= 'shutdown';
    const id = ++nextId;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Hosted worker command timeout: ${command}`));
      }, 20000);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      const failed = (error: Error | null) => {
        if (error) {
          const waiter = pending.get(id);
          pending.delete(id);
          waiter?.reject(error);
        }
      };
      try {
        child.send({ id, command }, failed);
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async function kill() {
    if (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL')) requestedExit = 'kill';
    return waitForExit();
  }
  async function waitForExit() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Owned hosted worker did not exit\n${logs}`)), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function close(): Promise<void> {
    return (closing ??= (async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        const result = await waitForExit();
        if (requestedExit === 'kill') return;
        if (requestedExit !== 'shutdown')
          throw new Error(`Hosted worker exited before shutdown: ${result.code}/${result.signal}\n${logs}`);
        assert.equal(result.code, 0, `Hosted worker shutdown failed: ${logs}`);
        return;
      }
      try {
        await command('shutdown');
        const result = await waitForExit();
        assert.equal(result.code, 0, `Hosted worker shutdown failed: ${logs}`);
      } catch (error) {
        await kill();
        throw error;
      }
    })());
  }
  try {
    await waitFor(() => events.some((event) => event.event === 'ready'), 'Hosted worker did not become ready');
    const ready = events.find((event) => event.event === 'ready');
    assert.equal(ready?.entry, entry.href, 'Worker must acknowledge the selected source/compiled entry');
    assert.equal(
      ready.coordinatorEntry,
      new URL(`../../evaluation-runs/hosted-coordinator.${input.runtime === 'source' ? 'ts' : 'js'}`, entry).href,
      'Worker must load the coordinator from the selected source/compiled directory',
    );
    return {
      command,
      exited,
      events,
      waitFor,
      kill,
      close,
    };
  } catch (error) {
    await kill();
    throw error;
  }
}
