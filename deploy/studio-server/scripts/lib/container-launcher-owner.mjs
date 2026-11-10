import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readContainerState } from './container-server-files.mjs';

const execute = promisify(execFile);
const busyMessage = 'This installation already has a launcher owner.';

function readOwnership(file) {
  try {
    return readContainerState(file);
  } catch (error) {
    // The owner can finish between the ordinary-file check and the read.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Only used for old, empty lock files. No process is ever killed by discovery. */
export async function findLegacyContainerLaunchers() {
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const values = stdout.trim() ? JSON.parse(stdout) : [];
    return (Array.isArray(values) ? values : [values])
      .filter(
        (value) =>
          value.ProcessId !== process.pid && (!value.CommandLine || value.CommandLine.includes('container-server.mjs')),
      )
      .map((value) => value.ProcessId);
  }
  const { stdout } = await execute('ps', ['-eo', 'pid=,comm=,args='], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return match &&
      Number(match[1]) !== process.pid &&
      /^(node|nodejs)$/.test(path.basename(match[2])) &&
      match[3].includes('container-server.mjs')
      ? [Number(match[1])]
      : [];
  });
}

function parseOwner(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The launcher owner record is invalid; preserve it for inspection.');
  }
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !/^[a-f0-9-]{36}$/.test(value.token ?? '') ||
    typeof value.host !== 'string' ||
    typeof value.identity !== 'string' ||
    !['dev', 'staging', 'prod'].includes(value.stage)
  )
    throw new Error('The launcher owner record is invalid; preserve it for inspection.');
  return value;
}

function readOwner(directory) {
  let entry;
  try {
    entry = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error('Launcher ownership must use an ordinary directory.');
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!files.length) return { file: null };
  if (files.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(files[0]))
    throw new Error('The launcher ownership directory contains unexpected files.');
  const text = readOwnership(path.join(directory, files[0]));
  if (text === null) return null;
  const owner = parseOwner(text);
  if (files[0] !== `owner-${owner.token}.json`) throw new Error('The launcher owner token does not match its file.');
  return { owner, file: files[0] };
}

function removeOwner(directory, file) {
  // The unique filename makes competing stale-owner cleanup safe: it cannot
  // delete a newly published owner's record. Never recursively remove locks.
  let entry;
  try {
    entry = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error('Launcher ownership must use an ordinary directory.');
  if (file) {
    try {
      fs.unlinkSync(path.join(directory, file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

/** Serialize launches; development can wait for live owners and reclaim dead ones. */
export async function acquireContainerLauncher(
  directory,
  {
    stage,
    identity,
    restart = false,
    timeoutMs = 30 * 60_000,
    pollMs = 250,
    findLegacyOwners = findLegacyContainerLaunchers,
    onWait = () => console.log('A previous launch is still running; waiting for it to finish before restarting.'),
  } = {},
) {
  const owner = { version: 1, pid: process.pid, token: randomUUID(), host: os.hostname(), stage, identity };
  const file = `owner-${owner.token}.json`;
  const guard = path.join(directory, 'launcher.owner');
  const prepared = path.join(directory, `.launcher-${owner.token}.tmp`);
  const lock = path.join(directory, 'launcher.lock');
  fs.mkdirSync(prepared, { mode: 0o700 });
  let ownsGuard = false;
  let waiting = false;
  let acquisitionRaces = 0;
  const deadline = Date.now() + timeoutMs;
  const readStable = async (read) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return read();
      } catch (error) {
        // Windows can temporarily deny opening a record pending deletion.
        // Retrying this read does not remove or replace any ownership state.
        if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  };
  const wait = async () => {
    if (!waiting) {
      waiting = true;
      onWait();
    }
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for the previous launcher. Its ownership and data were preserved.');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  };
  const assertSameInstallation = (previous) => {
    if (previous.host !== owner.host || previous.stage !== stage || previous.identity !== identity)
      throw new Error('Launcher ownership belongs to another host, stage or storage configuration.');
  };
  try {
    fs.writeFileSync(path.join(prepared, file), JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    for (;;) {
      try {
        // Publish a nonempty directory atomically. Another owner can never
        // observe a half-written record, including after a process crash.
        fs.renameSync(prepared, guard);
        ownsGuard = true;
        break;
      } catch (error) {
        const previous = await readStable(() => readOwner(guard));
        if (!previous) {
          // Windows may report EPERM when an owner releases its directory
          // during rename. Retry only a few times when that owner is now gone.
          if (['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) && acquisitionRaces++ < 5) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            continue;
          }
          throw error;
        }
        acquisitionRaces = 0;
        if (!restart) throw new Error(busyMessage);
        if (!previous.file) {
          removeOwner(guard, null);
          continue;
        }
        assertSameInstallation(previous.owner);
        if (!alive(previous.owner.pid)) {
          removeOwner(guard, previous.file);
          continue;
        }
        await wait();
      }
    }
    for (;;) {
      const previous = await readStable(() => readOwnership(lock));
      if (previous !== null) {
        if (!restart) throw new Error(busyMessage);
        let running;
        if (previous.trim()) {
          const recorded = parseOwner(previous);
          assertSameInstallation(recorded);
          running = alive(recorded.pid);
        } else running = (await findLegacyOwners()).length > 0;
        if (running) {
          await wait();
          continue;
        }
        try {
          fs.unlinkSync(lock);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      try {
        fs.writeFileSync(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        const recorded = readOwnership(lock);
        if (recorded !== null) {
          if (parseOwner(recorded).token !== owner.token) throw new Error('Launcher ownership changed before release.');
          fs.unlinkSync(lock);
        }
      } finally {
        removeOwner(guard, file);
      }
    };
  } catch (error) {
    if (ownsGuard) removeOwner(guard, file);
    throw error;
  } finally {
    removeOwner(prepared, file);
  }
}
