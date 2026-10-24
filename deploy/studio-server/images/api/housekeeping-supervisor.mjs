import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acquireMaintenanceLock } from './maintenance-lock.mjs';
import { createApiRetirementParticipant } from './backend-retirement.mjs';

/** Opt-in worker lifecycle. Developer readiness never depends on owning this lock. */
export function createHousekeepingSupervisor({ env, incarnation, command, token, timeoutMs = 300000 }) {
  const root = env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore';
  const descriptor = path.join(root, 'housekeeping-owner.json');
  const port = Number(env.RIVET_HOUSEKEEPING_PORT);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !env.RIVET_POD_UID ||
    !env.RIVET_POD_IP ||
    !env.RIVET_NAMESPACE_UID
  )
    throw Error('Housekeeping worker identity/port is incomplete.');
  let lease,
    child,
    closed,
    operationId = null,
    state = 'standby',
    pending,
    capability;
  const snapshot = () => ({ protocol: 1, podUid: env.RIVET_POD_UID, incarnation, operationId, state });
  const write = async (value) => {
    const temporary = `${descriptor}.${incarnation}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, descriptor);
  };
  const acquire = async (id) => {
    if (state === 'owner') return snapshot();
    if (state !== 'standby' && state !== 'released') throw Error('Housekeeping lifecycle is unsettled.');
    operationId = id;
    state = 'acquiring';
    lease = await acquireMaintenanceLock(root);
    if (!lease) {
      state = 'standby';
      return snapshot();
    }
    capability = randomBytes(32).toString('hex');
    const preload = pathToFileURL(path.join(import.meta.dirname, 'maintenance-lock-inherit.mjs')).href;
    const workerEnv = {
      ...env,
      PORT: String(port),
      RIVET_HA_MAINTENANCE: '1',
      RIVET_HA_API_ONLY: '1',
      RIVET_HA_PROTOCOL: '0',
      RIVET_RUNTIME_LIBRARIES_REPLICA_TIER: 'none',
      RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED: 'true',
      RIVET_MANAGED_MAINTENANCE_ENABLED: 'true',
      RIVET_PROJECT_BUNDLE_SCRATCH_ROOT: path.join(root, 'bundles'),
      RIVET_ROLLING_RETIREMENT_TOKEN: token,
      RIVET_PROCESS_INCARNATION: incarnation,
      RIVET_HOUSEKEEPING_CAPABILITY: capability,
      RIVET_MAINTENANCE_LOCK_INHERITED: '1',
      NODE_OPTIONS: `${env.NODE_OPTIONS || ''} --import=${preload}`.trim(),
    };
    const [program, ...args] = Array.isArray(command) ? command : [command];
    child = spawn(program, args, {
      env: workerEnv,
      stdio: ['ignore', 'inherit', 'inherit', lease.fd],
      windowsHide: true,
    });
    let exit;
    closed = new Promise((resolve) => {
      child.once('error', () => {
        exit = true;
      });
      child.once('close', () => {
        exit = true;
        if (state === 'owner' || state === 'acquiring' || state === 'waiting') state = 'failed';
        resolve();
      });
    });
    const deadline = Date.now() + timeoutMs;
    while (!exit) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1500) });
        const health = await response.json().catch(() => null);
        if (response.ok || (response.status === 503 && health?.restoreMaintenance === true)) {
          const contractResponse = await fetch(`http://127.0.0.1:${port}/internal/ha/runtime-contract`, {
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
            headers: {
              'x-rivet-proxy-auth': createHash('sha256').update(`${env.RIVET_KEY}:proxy-auth`).digest('hex'),
              'x-rivet-housekeeping-incarnation': incarnation,
              'x-rivet-housekeeping-capability': capability,
            },
          });
          const contract = contractResponse.ok ? await contractResponse.json() : null;
          if (
            contract?.maintenanceOwner !== true ||
            (!response.ok && contract.maintenanceReady !== true) ||
            contract.housekeepingIdentity?.podUid !== env.RIVET_POD_UID ||
            contract.housekeepingIdentity?.incarnation !== incarnation
          )
            throw Error('Worker identity is not ready.');
          if (exit) break;
          await write({
            ...snapshot(),
            state: 'owner',
            namespaceUid: env.RIVET_NAMESPACE_UID,
            address: env.RIVET_POD_IP,
            port,
            capability,
          });
          if (exit) break;
          state = 'owner';
          return snapshot();
        }
      } catch {
        /* Remain unadvertised until actual readiness. */
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    state = 'failed';
    throw Error('Housekeeping worker did not become ready; ownership retained for inspection.');
  };
  const release = async (id, restoreRestart = false) => {
    if (state === 'released' && operationId === id) return snapshot();
    if (state !== 'owner') throw Error('Housekeeping owner is not confirmed.');
    operationId = id;
    state = 'waiting';
    const headers = {
      'x-rivet-housekeeping-operation': id,
      'x-rivet-housekeeping-incarnation': incarnation,
      'x-rivet-housekeeping-capability': capability,
      ...(restoreRestart ? { 'x-rivet-housekeeping-restore-restart': '1' } : {}),
      'x-rivet-proxy-auth': createHash('sha256').update(`${env.RIVET_KEY}:proxy-auth`).digest('hex'),
    };
    let method = restoreRestart ? 'GET' : 'POST';
    while (true) {
      const response = await fetch(`http://127.0.0.1:${port}/internal/housekeeping/handover`, {
        method,
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Error('Housekeeping admission handover is unconfirmed; old worker retained.');
      const observed = await response.json();
      if (observed.operationId !== id || observed.protocol !== 1)
        throw Error('Housekeeping handover identity changed.');
      if (observed.idle) break;
      // Finish/confirm/cancel accepted restores before fencing their API.
      method = 'GET';
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    state = 'draining';
    if (!restoreRestart) {
      const participant = createApiRetirementParticipant(`http://127.0.0.1:${port}/internal/process-retirement`, token);
      await participant.begin(id, incarnation);
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const observed = await participant.status();
        if (observed.incarnation !== incarnation || observed.operationId !== id)
          throw Error('Housekeeping retirement identity changed.');
        if (observed.state === 'drained') break;
        if (observed.state !== 'draining' || Date.now() >= deadline)
          throw Error('Housekeeping work is still active; worker and lock retained.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await write({ ...snapshot(), state: 'handover', namespaceUid: env.RIVET_NAMESPACE_UID });
    child.kill('SIGTERM');
    // No shutdown timeout is allowed to relinquish an unsettled kernel lock.
    await closed;
    await lease.close();
    lease = undefined;
    state = 'released';
    return snapshot();
  };
  return {
    snapshot,
    command(action, id) {
      if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw Error('Housekeeping operation token required.');
      if (pending) throw Error('Housekeeping command is already in flight; observe before recovery.');
      if (action === 'acquire' && state === 'owner' && operationId !== id)
        throw Error('Housekeeping operation identity changed; existing owner retained.');
      pending = (
        action === 'acquire'
          ? acquire(id)
          : action === 'release'
            ? release(id)
            : Promise.reject(Error('Unknown housekeeping action.'))
      )
        .catch((error) => {
          if (state !== 'standby') state = 'failed';
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
    async stop({ restoreRestart = false } = {}) {
      if (pending) await pending.catch(() => {});
      if (state === 'owner') await release(incarnation, restoreRestart);
      if (lease) {
        throw Error('Housekeeping shutdown is unconfirmed; kernel ownership retained.');
      }
      state = 'stopped';
    },
  };
}
