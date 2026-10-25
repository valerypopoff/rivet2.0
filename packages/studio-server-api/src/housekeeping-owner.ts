import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { DeploymentStatus } from '../../studio-server-shared/deployment-status-types.js';

let admissionClosed = false;
export function assertHousekeepingWorkerOwnership(env: NodeJS.ProcessEnv = process.env): void {
  if (env.RIVET_HA_CONTROL_PLANE_MODE !== 'singleton-overlap' || env.RIVET_HA_MAINTENANCE !== '1') return;
  if (
    process.platform !== 'linux' ||
    (globalThis as Record<symbol, unknown>)[Symbol.for('rivet.housekeeping.kernel-owner')] !== true
  )
    throw Error('The overlap maintenance worker requires verified inherited kernel ownership.');
}
export function closeHousekeepingAdmission(): void {
  admissionClosed = true;
}
export function getHousekeepingAdmissionState(): 'ready' | 'handover' {
  return admissionClosed ? 'handover' : 'ready';
}

export async function getHousekeepingReadiness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NonNullable<DeploymentStatus['housekeepingReadiness']>> {
  let owner;
  try {
    owner = await readHousekeepingOwner(env);
  } catch {
    return { state: 'handover' };
  }
  try {
    const address = owner.address.includes(':') ? `[${owner.address}]` : owner.address;
    const response = await fetch(`http://${address}:${owner.port}/internal/ha/runtime-contract`, {
      redirect: 'error',
      signal: AbortSignal.timeout(1500),
      headers: {
        'x-rivet-proxy-auth': createHash('sha256').update(`${env.RIVET_KEY}:proxy-auth`).digest('hex'),
        'x-rivet-housekeeping-incarnation': owner.incarnation,
        'x-rivet-housekeeping-capability': owner.capability,
      },
    });
    const contract = response.ok ? await response.json() : null;
    if (
      contract?.maintenanceOwner === true &&
      contract.housekeepingIdentity?.podUid === owner.podUid &&
      contract.housekeepingIdentity?.incarnation === owner.incarnation
    )
      return { state: contract.housekeepingAdmission === 'handover' ? 'handover' : 'ready', ownerPodUid: owner.podUid };
  } catch {
    /* Descriptor advertisement alone is not worker availability. */
  }
  return { state: 'unavailable', ownerPodUid: owner.podUid };
}

export async function readHousekeepingOwner(env: NodeJS.ProcessEnv = process.env) {
  const file = path.join(env.RIVET_LEGACY_RESTORE_ROOT || '/data/rivet-restore', 'housekeeping-owner.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
    throw Error('Housekeeping owner descriptor is unsafe.');
  const owner = JSON.parse(await fs.readFile(file, 'utf8'));
  if (
    owner.protocol !== 1 ||
    owner.state !== 'owner' ||
    owner.namespaceUid !== env.RIVET_NAMESPACE_UID ||
    !isIP(owner.address ?? '') ||
    !Number.isInteger(owner.port) ||
    owner.port < 1 ||
    owner.port > 65535 ||
    !/^[a-f0-9-]{36}$/.test(owner.incarnation ?? '') ||
    !/^[a-f0-9-]{36}$/.test(owner.podUid ?? '') ||
    !/^[a-f0-9]{64}$/.test(owner.capability ?? '')
  )
    throw Error('Housekeeping handover is not settled.');
  return owner as {
    protocol: 1;
    address: string;
    port: number;
    incarnation: string;
    podUid: string;
    capability: string;
  };
}

/** The private worker never treats an external/UI request as an internal hop. */
export function createHousekeepingIncarnationGuard(
  env: NodeJS.ProcessEnv,
  accepting = () => !admissionClosed,
): RequestHandler {
  return (req, res, next) => {
    if (env.RIVET_HA_CONTROL_PLANE_MODE !== 'singleton-overlap' || env.RIVET_HA_MAINTENANCE !== '1') return next();
    const supplied = Buffer.from(String(req.headers['x-rivet-housekeeping-capability'] ?? ''));
    const expected = Buffer.from(env.RIVET_HOUSEKEEPING_CAPABILITY ?? '');
    if (
      !expected.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      req.headers['x-rivet-housekeeping-incarnation'] !== env.RIVET_PROCESS_INCARNATION
    ) {
      res.status(503).json({
        code: 'housekeeping_handover',
        error: 'Maintenance handover in progress. This request was not retried.',
      });
      return;
    }
    if (
      !accepting() &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      /^\/api\/workflows\/project-bundles(?:\/container)?\/?(?:\?|$)/.test(req.originalUrl)
    ) {
      res.set('Retry-After', '2').status(503).json({
        code: 'housekeeping_handover',
        error: 'Maintenance handover in progress. This request was not accepted or retried.',
      });
      return;
    }
    next();
  };
}
export const requireHousekeepingIncarnation: RequestHandler = (req, res, next) =>
  createHousekeepingIncarnationGuard(process.env)(req, res, next);
