import { validGeneration } from './generations.mjs';

/** Fence every IPC callback by the exact child, including callbacks after exit. */
export function observeBuilder(
  builder,
  {
    isCurrent,
    compiler,
    onStatus,
    onFailure,
    onPublish,
    beforeCompile,
    timeoutMs = 15 * 60_000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  },
) {
  let activePid;
  let deadline;
  let publishing = false;
  let sourceVersion = 0;
  const clearDeadline = () => {
    clearTimer(deadline);
    deadline = undefined;
    activePid = undefined;
  };
  builder.on('message', (message) => {
    if (!isCurrent(builder)) return;
    if (message?.type === 'compiler-started') {
      if (!compiler.track(message.pid)) return;
      clearDeadline();
      activePid = message.pid;
      const pid = activePid;
      deadline = setTimer(() => {
        if (!isCurrent(builder) || activePid !== pid) return;
        clearDeadline();
        builder.kill('SIGTERM');
        onFailure(
          Object.assign(
            new Error(
              'Frontend build exceeded its 15-minute deadline. Retrying; the previous bundle remains available.',
            ),
            {
              code: 'RIVET_DEV_BUILD_TIMEOUT',
            },
          ),
        );
      }, timeoutMs);
      deadline?.unref?.();
      const acknowledge = () => {
        if (isCurrent(builder) && builder.connected !== false && activePid === pid)
          builder.send({ type: 'compiler-tracked', pid });
      };
      if (beforeCompile)
        Promise.resolve()
          .then(beforeCompile)
          .then(acknowledge, (error) => {
            if (isCurrent(builder) && activePid === pid) onFailure(error);
          });
      else acknowledge();
      return;
    }
    if (message?.type === 'source-changed' && message.pid === activePid) {
      sourceVersion++;
      return;
    }
    if (message?.type === 'publish-build') {
      if (!onPublish || publishing || message.pid !== activePid) return;
      publishing = true;
      const pid = activePid;
      const version = sourceVersion;
      const isOwner = () => isCurrent(builder) && builder.connected !== false && activePid === pid;
      const isAccepted = () => isOwner() && sourceVersion === version;
      Promise.resolve()
        .then(() => onPublish(isAccepted))
        .then(
          (result) => {
            if (isOwner()) builder.send({ type: 'publication-result', pid, ...result });
          },
          (error) => {
            if (isOwner()) builder.send({ type: 'publication-result', pid, error: error.message, code: error.code });
          },
        )
        .finally(() => {
          publishing = false;
        });
      return;
    }
    if (message?.type === 'compiler-stopped') {
      if (activePid === message.pid) clearDeadline();
      compiler.forget(message.pid);
      return;
    }
    if (!message || !['ready', 'building', 'failed'].includes(message.phase)) return;
    if (message.phase === 'ready' && !validGeneration(message.generation)) return;
    onStatus(message);
  });
  builder.on('error', (error) => {
    clearDeadline();
    if (!isCurrent(builder)) return;
    builder.kill('SIGTERM');
    onFailure(error);
  });
  builder.on('exit', () => {
    clearDeadline();
    if (isCurrent(builder)) onFailure();
  });
}
