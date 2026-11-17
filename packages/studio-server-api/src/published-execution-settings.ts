import path from 'node:path';

import type {
  PublishedExecutionPolicySnapshot,
  PublishedExecutionSettings,
} from '../../studio-server-shared/app-settings-types.js';
import { VersionedSettingsRepository, type SettingsSnapshot } from './app-settings/settings-repository.js';
import { requireSettingsRecord } from './app-settings/schema.js';
import {
  getPublishedExecutionAdmissionConfig,
  type PublishedExecutionAdmission,
  type PublishedExecutionAdmissionMode,
} from './published-execution-admission.js';
import { badRequest, createHttpError } from './utils/httpError.js';

export const PUBLISHED_EXECUTION_SETTINGS_KEY = 'published execution';
export const PUBLISHED_EXECUTION_DEFAULTS_ENV = 'RIVET_DEPLOYMENT_PUBLISHED_EXECUTION_DEFAULTS';

type StoredPolicy = {
  installation: string | null;
  maxActiveRunsPerPod: number | null;
  updatedAt: string | null;
};

function limit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw badRequest('Concurrent runs per execution Pod must be an integer from 1 to 10000.');
  }
  return value;
}

function installation(env: NodeJS.ProcessEnv): string | null {
  const value = env.RIVET_LEGACY_RESTORE_INSTALLATION?.trim();
  if (!value) return null;
  if (!/^[a-z0-9][a-z0-9./_-]{0,255}$/.test(value)) throw new Error('Invalid execution policy installation identity.');
  return value;
}

export function publishedExecutionDefaults(env: NodeJS.ProcessEnv = process.env): {
  maxActiveRunsPerPod: number | null;
  mode: PublishedExecutionAdmissionMode;
} {
  const metadata = env[PUBLISHED_EXECUTION_DEFAULTS_ENV]?.trim();
  if (metadata) {
    const value = requireSettingsRecord(JSON.parse(metadata), 'Invalid published execution defaults.');
    if (!['disabled', 'observe', 'enforce'].includes(String(value.mode))) {
      throw new Error('Invalid published execution default mode.');
    }
    return {
      maxActiveRunsPerPod: limit(value.maxActiveRunsPerPod),
      mode: value.mode as PublishedExecutionAdmissionMode,
    };
  }
  // Compatibility for execution fixtures/older launchers, never invent a
  // control-plane default from its disabled admission singleton.
  const config = getPublishedExecutionAdmissionConfig(env);
  return { maxActiveRunsPerPod: config.mode === 'disabled' ? null : config.maxActiveRuns, mode: config.mode };
}

function parsePolicy(value: Record<string, unknown>): StoredPolicy {
  const scope = value.installation;
  if (scope !== null && (typeof scope !== 'string' || !/^[a-z0-9][a-z0-9./_-]{0,255}$/.test(scope))) {
    throw new TypeError('Invalid saved execution policy installation.');
  }
  const max = value.maxActiveRunsPerPod === null ? null : limit(value.maxActiveRunsPerPod);
  if (max !== null && scope === null) throw new TypeError('Saved execution override has no installation.');
  if (
    value.updatedAt !== null &&
    (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))
  ) {
    throw new TypeError('Invalid execution policy update time.');
  }
  return { installation: scope, maxActiveRunsPerPod: max, updatedAt: value.updatedAt as string | null };
}

export const publishedExecutionSettingsRepository = new VersionedSettingsRepository<StoredPolicy>({
  key: PUBLISHED_EXECUTION_SETTINGS_KEY,
  currentVersion: 1,
  optionalRestore: true,
  capturePerRequest: false,
  getPath: () =>
    path.join(
      process.env.RIVET_APP_DATA_ROOT?.trim() || path.resolve(process.cwd(), '../../.data/rivet-app'),
      'settings/published-execution.json',
    ),
  getDefault: () => ({ installation: null, maxActiveRunsPerPod: null, updatedAt: null }),
  parseStored: parsePolicy,
  serialize: (value) => ({ ...value }),
});

function settings(value: Readonly<StoredPolicy>, env = process.env): PublishedExecutionSettings {
  const defaults = publishedExecutionDefaults(env);
  const scope = installation(env);
  const owns = scope !== null && value.installation === scope;
  const override = owns ? value.maxActiveRunsPerPod : null;
  return {
    maxActiveRunsPerPod: override,
    deploymentDefault: defaults.maxActiveRunsPerPod,
    effectiveMaxActiveRunsPerPod: override ?? defaults.maxActiveRunsPerPod,
    source: override === null ? 'deployment' : 'app-settings',
    mode: defaults.mode,
    editable: scope !== null && defaults.mode === 'enforce' && defaults.maxActiveRunsPerPod !== null,
    updatedAt: owns ? value.updatedAt : null,
  };
}

export async function readPublishedExecutionSettings(): Promise<PublishedExecutionSettings> {
  return settings((await publishedExecutionSettingsRepository.read()).value);
}

export async function writePublishedExecutionSettings(
  draft: unknown,
  expectedRevision?: string,
): Promise<PublishedExecutionSettings> {
  if (!expectedRevision) throw createHttpError(428, 'Reload execution settings before saving.');
  const raw = requireSettingsRecord(draft, 'Execution settings must be an object.');
  if (Object.keys(raw).length !== 1 || !Object.hasOwn(raw, 'maxActiveRunsPerPod')) {
    throw badRequest('Provide only maxActiveRunsPerPod.');
  }
  const max = raw.maxActiveRunsPerPod === null ? null : limit(raw.maxActiveRunsPerPod);
  const result = await publishedExecutionSettingsRepository.update((previous) => {
    if (!settings(previous).editable)
      throw createHttpError(409, 'This deployment does not support live enforced execution limits.');
    return { installation: installation(process.env), maxActiveRunsPerPod: max, updatedAt: new Date().toISOString() };
  }, expectedRevision);
  return settings(result.value);
}

/** Bind once after repositories initialize. No settings reads occur on admission. */
export function bindPublishedExecutionSettings(admission: PublishedExecutionAdmission, env = process.env) {
  env = { ...env };
  const scope = installation(env);
  const defaults = publishedExecutionDefaults(env);
  const config = admission.getSnapshot();
  if (!scope && env[PUBLISHED_EXECUTION_DEFAULTS_ENV]?.trim()) {
    throw new Error('Live execution policy metadata requires an installation identity.');
  }
  // Older compatibility fixtures without a deployment identity retain fixed admission.
  if (!scope || defaults.maxActiveRunsPerPod === null) return { dispose() {}, snapshot: () => undefined };
  if (defaults.mode !== config.mode || defaults.maxActiveRunsPerPod !== config.maxActiveRuns) {
    throw new Error('Execution bootstrap admission differs from deployment metadata.');
  }
  let applied: SettingsSnapshot<StoredPolicy>;
  const apply = (snapshot: SettingsSnapshot<StoredPolicy>) => {
    admission.setMaxActiveRuns(settings(snapshot.value, env).effectiveMaxActiveRunsPerPod!);
    applied = snapshot;
  };
  const unsubscribe = publishedExecutionSettingsRepository.subscribe(apply);
  try {
    apply(publishedExecutionSettingsRepository.readSync());
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return {
    dispose: unsubscribe,
    snapshot(): PublishedExecutionPolicySnapshot {
      // This is a diagnostic/control read, not part of accepting a graph.
      if (publishedExecutionSettingsRepository.readSync().revision !== applied.revision) {
        throw new Error('Execution admission policy has not synchronized.');
      }
      const current = admission.getSnapshot();
      return {
        protocol: 1,
        installation: scope,
        deploymentDefault: defaults.maxActiveRunsPerPod!,
        revision: applied.revision,
        source: settings(applied.value, env).source,
        mode: current.mode,
        limit: current.maxActiveRuns,
        active: current.activeRuns,
        draining: current.draining,
      };
    },
  };
}
