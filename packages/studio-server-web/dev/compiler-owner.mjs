/** Track only the compiler spawned by our private builder IPC protocol. */
export function createCompilerOwner(kill = process.kill) {
  let pid;
  return {
    track(value) {
      if (!Number.isSafeInteger(value) || value <= 1) return false;
      pid = value;
      return true;
    },
    forget(value) {
      if (pid === value) pid = undefined;
    },
    stop() {
      if (pid === undefined) return;
      const owned = pid;
      pid = undefined;
      try {
        // A busy compiler can defer JavaScript signal/disconnect handlers.
        kill(owned, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    },
  };
}
