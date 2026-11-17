import { randomUUID } from 'node:crypto';
import type {
  ResourceAllocation,
  ResourceRole,
} from '@valerypopoff/rivet-studio-server-shared/resource-monitoring-types.js';
import type { ApiRuntimeProfile } from '../runtime-profile.js';
import { isControlPlaneApiProfile, isPublishedExecutionApiProfile } from '../runtime-profile.js';
import { getExpectedExecutorAuthToken } from '../auth.js';
import { acquireManagedPostgresPool, type ManagedPostgresPoolLease } from '../managed-postgres-pool.js';
import { getManagedDbPoolConfig } from '../routes/workflows/managed/db.js';
import {
  getManagedWorkflowStorageConfig,
  isManagedWorkflowStorageEnabled,
} from '../routes/workflows/storage-config.js';
import { getPublishedExecutionAdmission } from '../published-execution-admission.js';
import { createResourceCounterReader } from './counters.js';
import { createResourceSampler } from './sampler.js';
import { ResourceMonitoringHub } from './service.js';
import { ResourceMonitoringStore } from './store.js';

let hub: ResourceMonitoringHub | undefined;
let sampler: ReturnType<typeof createResourceSampler> | undefined;
let lease: ManagedPostgresPoolLease | undefined;
let stopped = false;
let starting = false;

export function getResourceMonitoringHub() {
  return hub;
}
export async function startResourceMonitoring(profile: ApiRuntimeProfile): Promise<void> {
  if (
    starting ||
    sampler ||
    process.env.RIVET_HA_MAINTENANCE === '1' ||
    process.env.RIVET_RUNTIME_PROCESS_ROLE === 'executor'
  )
    return;
  starting = true;
  stopped = false;
  try {
    const text = process.env.RIVET_DEPLOYMENT_RESOURCE_MONITORING;
    if (!text || profile === 'evaluation' || !isManagedWorkflowStorageEnabled()) return;
    const config = JSON.parse(text) as {
      enabled: boolean;
      containerized: boolean;
      name: string;
      reportUrl: string;
      allocation?: ResourceAllocation;
    };
    if (config.enabled !== true) return;
    const installation = process.env.RIVET_LEGACY_RESTORE_INSTALLATION;
    if (!installation || !getExpectedExecutorAuthToken()) return;
    const url = new URL(config.reportUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/internal/resource-monitoring'
    )
      return;
    const reader = await createResourceCounterReader({ containerized: config.containerized === true });
    if (stopped) return;
    if (isControlPlaneApiProfile(profile)) {
      lease = acquireManagedPostgresPool(getManagedDbPoolConfig(getManagedWorkflowStorageConfig()));
      hub = new ResourceMonitoringHub(installation, new ResourceMonitoringStore(lease.pool, installation));
      hub.start();
    }
    const allocation: ResourceAllocation = {
      cpuRequestMillicores: null,
      memoryRequestBytes: null,
      cpuLimitMillicores: null,
      memoryLimitBytes: null,
    };
    for (const key of Object.keys(allocation) as Array<keyof ResourceAllocation>) {
      const value = config.allocation?.[key];
      if (value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0)
        allocation[key] = Number(value);
    }
    sampler = createResourceSampler({
      identity: {
        installation,
        incarnation: randomUUID(),
        role: profile as ResourceRole,
        name: typeof config.name === 'string' ? config.name : profile,
        source: reader.source,
      },
      allocation,
      reader,
      activity: () => (isPublishedExecutionApiProfile(profile) ? getPublishedExecutionAdmission().getSnapshot() : null),
      report: async (report, signal) => {
        if (hub) {
          hub.ingest(report);
          return;
        }
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rivet-executor-auth': getExpectedExecutorAuthToken() },
          body: JSON.stringify(report),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Error('Resource report unavailable');
        }
        await response.body?.cancel();
      },
    });
    sampler.start();
  } catch {
    // Optional telemetry never changes serving readiness or accepted work.
    stopResourceMonitoring();
  } finally {
    starting = false;
  }
}
export function stopResourceMonitoring(): void {
  stopped = true;
  sampler?.stop();
  hub?.stop();
  sampler = undefined;
  hub = undefined;
  const owned = lease;
  lease = undefined;
  void owned?.release().catch(() => undefined);
}
