import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Assign the process tree to its kernel job during creation, before it runs. */
export function spawnOwnedWindowsCommand(
  program,
  args,
  { retainOnFailure = false, stopOnInputClose = false, ...options },
) {
  return spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./owned-command-windows.ps1', import.meta.url))],
    {
      ...options,
      shell: false,
      windowsHide: true,
      env: {
        ...(options.env ?? process.env),
        RIVET_OWNED_COMMAND_PLAN: Buffer.from(
          JSON.stringify({ program, args, cwd: options.cwd ?? process.cwd(), retainOnFailure, stopOnInputClose }),
        ).toString('base64'),
      },
    },
  );
}

/** Bound inspector/helper settlement; false is uncertainty, never success. */
export async function settleOwnedCommandTree(child, timeoutMs = 5000) {
  let expired = false,
    timeout;
  const helpers = new Set();
  try {
    return await Promise.race([
      stopOwnedCommandTree(child, {
        spawnProcess: spawn,
        platform: process.platform,
        signalProcess: process.kill,
        isSettled: () => expired,
        onHelper: (helper) => {
          helpers.add(helper);
          helper.once('close', () => helpers.delete(helper));
        },
      }).catch(() => false),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          expired = true;
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timeout);
    for (const helper of helpers) {
      tryKill(helper);
      helper.stdout?.destroy();
      helper.unref();
    }
  }
}

export function tryKill(child) {
  try {
    return child.kill('SIGKILL');
  } catch {
    return false;
  }
}

export async function stopOwnedCommandTree(child, { spawnProcess, platform, onHelper, signalProcess, isSettled }) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  if (platform !== 'win32') {
    try {
      signalProcess(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
    // Delivery is asynchronous. Parent closure does not prove that every child
    // has left the kernel (a paused child can even retain a listening socket).
    // Poll only this freshly owned process group, under the caller's existing
    // shutdown deadline. Zombies are terminal and may await reaping by PID 1.
    while (!isSettled()) {
      const stopped = await inspectAdapterGroup(child.pid, { spawnProcess, onHelper });
      if (stopped !== false) return stopped === true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }
  // This PID is the still-owned child object, not a discovered process name.
  // /T includes its pg_dump/local-restore children; /F cannot be ignored by an
  // adapter's signal handler. Wait for the command before reporting failure.
  return new Promise((resolve) => {
    const taskkill = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    });
    onHelper(taskkill);
    taskkill.once('error', () => {
      tryKill(child);
      resolve(false);
    });
    taskkill.once('close', (code) => {
      if (code !== 0) tryKill(child);
      resolve(code === 0);
    });
  });
}

function inspectAdapterGroup(group, { spawnProcess, onHelper }) {
  return new Promise((resolve) => {
    const probe = spawnProcess('ps', ['-axo', 'pgid=,stat='], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    onHelper(probe); // The outer shutdown deadline kills/unrefs a hung probe.
    let output = '';
    let invalid = false;
    probe.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 1024 * 1024) {
        invalid = true;
        tryKill(probe);
      } else output += chunk;
    });
    probe.once('error', () => resolve(null));
    probe.once('close', (code) => {
      if (code !== 0 || invalid || !output.trim()) return resolve(null);
      let live = false;
      for (const line of output.split(/\r?\n/).filter((value) => value.trim())) {
        const entry = /^\s*(\d+)\s+([A-Zt][<NLSsl+EIXV]*)\s*$/.exec(line);
        if (!entry) return resolve(null);
        if (Number(entry[1]) === group && !/^[ZX]/.test(entry[2])) live = true;
      }
      resolve(!live);
    });
  });
}
