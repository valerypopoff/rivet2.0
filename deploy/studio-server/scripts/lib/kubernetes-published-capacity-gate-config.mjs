import fs from 'node:fs';
import path from 'node:path';

import { buildManagedProviderGateConfig } from './kubernetes-managed-provider-gate-config.mjs';

const stageNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;
const scenarioNames = new Set(['fast', 'long']);
const dnsLabelPattern = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const modes = new Set(['observe', 'certify']);

function assertObject(value, name) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`[kubernetes-published-capacity-gate] ${name} must be an object`);
  }
  return value;
}

function assertInteger(value, name, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`[kubernetes-published-capacity-gate] ${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertFiniteNumber(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`[kubernetes-published-capacity-gate] ${name} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function parseCapacity(rawConfig) {
  const capacity = assertObject(rawConfig.capacity, 'provider gate config.capacity');
  const stages = capacity.stages;
  if (!Array.isArray(stages) || stages.length === 0 || stages.length > 16) {
    throw new Error('[kubernetes-published-capacity-gate] capacity.stages must contain between 1 and 16 stages');
  }
  const names = new Set();
  let totalRequests = 0;
  const normalizedStages = stages.map((rawStage, index) => {
    const stage = assertObject(rawStage, `capacity.stages[${index}]`);
    const name = String(stage.name ?? '');
    const scenario = String(stage.scenario ?? '');
    const expect = stage.expect;
    if (!stageNamePattern.test(name) || names.has(name)) {
      throw new Error(
        `[kubernetes-published-capacity-gate] capacity.stages[${index}].name must be a unique lowercase DNS-label fragment`,
      );
    }
    if (!scenarioNames.has(scenario)) {
      throw new Error(`[kubernetes-published-capacity-gate] capacity.stages[${index}].scenario must be fast or long`);
    }
    if (expect !== 'success' && expect !== 'overload') {
      throw new Error(
        `[kubernetes-published-capacity-gate] capacity.stages[${index}].expect must be success or overload`,
      );
    }
    const concurrency = assertInteger(stage.concurrency, `capacity.stages[${index}].concurrency`, {
      minimum: 1,
      maximum: 256,
    });
    const requests = assertInteger(stage.requests, `capacity.stages[${index}].requests`, {
      minimum: 1,
      maximum: 20_000,
    });
    names.add(name);
    totalRequests += requests;
    return { name, scenario, expect, concurrency, requests };
  });
  if (totalRequests > 50_000) {
    throw new Error('[kubernetes-published-capacity-gate] capacity stages may request at most 50000 total executions');
  }
  if (!normalizedStages.some((stage) => stage.expect === 'overload')) {
    throw new Error(
      '[kubernetes-published-capacity-gate] capacity.stages must include an explicit overload stage to verify admission rejection',
    );
  }

  const thresholds = assertObject(capacity.thresholds, 'capacity.thresholds');
  const maximumP95Ms = assertObject(thresholds.maximumP95Ms, 'capacity.thresholds.maximumP95Ms');
  const normalizedMaximumP95Ms = {};
  for (const stage of normalizedStages) {
    normalizedMaximumP95Ms[stage.name] = assertFiniteNumber(
      maximumP95Ms[stage.name],
      `capacity.thresholds.maximumP95Ms.${stage.name}`,
      { minimum: 1, maximum: 600_000 },
    );
  }

  const serviceNamePrefix = String(capacity.serviceNamePrefix ?? '').trim();
  if (serviceNamePrefix && (!dnsLabelPattern.test(serviceNamePrefix) || serviceNamePrefix.length > 56)) {
    throw new Error(
      '[kubernetes-published-capacity-gate] capacity.serviceNamePrefix must be a DNS label of at most 56 characters when provided',
    );
  }

  return {
    serviceNamePrefix: serviceNamePrefix || undefined,
    stages: normalizedStages,
    requestTimeoutMs: assertInteger(capacity.requestTimeoutMs ?? 30_000, 'capacity.requestTimeoutMs', {
      minimum: 100,
      maximum: 120_000,
    }),
    controlCanaryEveryRequests: assertInteger(
      capacity.controlCanaryEveryRequests ?? 10,
      'capacity.controlCanaryEveryRequests',
      { minimum: 1, maximum: 10_000 },
    ),
    controlCanaryTimeoutMs: assertInteger(capacity.controlCanaryTimeoutMs ?? 5_000, 'capacity.controlCanaryTimeoutMs', {
      minimum: 100,
      maximum: 120_000,
    }),
    sampleIntervalMs: assertInteger(capacity.sampleIntervalMs ?? 5_000, 'capacity.sampleIntervalMs', {
      minimum: 500,
      maximum: 60_000,
    }),
    jobTimeoutSeconds: assertInteger(capacity.jobTimeoutSeconds ?? 900, 'capacity.jobTimeoutSeconds', {
      minimum: 30,
      maximum: 7_200,
    }),
    requireExecutionMetrics: capacity.requireExecutionMetrics !== false,
    thresholds: {
      maximumP95Ms: normalizedMaximumP95Ms,
      maximumUnexpectedRate: assertFiniteNumber(
        thresholds.maximumUnexpectedRate,
        'capacity.thresholds.maximumUnexpectedRate',
        { minimum: 0, maximum: 1 },
      ),
      maximumControlCanaryFailureRate: assertFiniteNumber(
        thresholds.maximumControlCanaryFailureRate,
        'capacity.thresholds.maximumControlCanaryFailureRate',
        { minimum: 0, maximum: 1 },
      ),
      maximumRecordingDrops: assertFiniteNumber(
        thresholds.maximumRecordingDrops,
        'capacity.thresholds.maximumRecordingDrops',
        { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      ),
    },
  };
}

function readRawConfig(configFile) {
  let contents;
  try {
    contents = fs.readFileSync(configFile, 'utf8');
  } catch (error) {
    throw new Error(
      `[kubernetes-published-capacity-gate] could not read provider gate config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return assertObject(JSON.parse(contents), 'provider gate config');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[kubernetes-published-capacity-gate]')) throw error;
    throw new Error(
      `[kubernetes-published-capacity-gate] provider gate config must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildPublishedCapacityGateConfig({ rootDir, env = process.env } = {}) {
  if (String(env.RIVET_K8S_CAPACITY_GATE_CONFIRM ?? '') !== 'certify-staging') {
    throw new Error('[kubernetes-published-capacity-gate] RIVET_K8S_CAPACITY_GATE_CONFIRM must equal certify-staging');
  }
  const mode = String(env.RIVET_K8S_CAPACITY_GATE_MODE ?? 'observe').trim();
  if (!modes.has(mode)) {
    throw new Error('[kubernetes-published-capacity-gate] RIVET_K8S_CAPACITY_GATE_MODE must be observe or certify');
  }
  const provider = buildManagedProviderGateConfig({ rootDir, env });
  const rawConfig = readRawConfig(provider.configFile);
  const capacity = parseCapacity(rawConfig);
  if (mode === 'certify' && !capacity.requireExecutionMetrics) {
    throw new Error('[kubernetes-published-capacity-gate] certify mode requires capacity.requireExecutionMetrics=true');
  }
  const artifactsDir = path.resolve(provider.artifactsDir, 'published-capacity');
  const relative = path.relative(rootDir, artifactsDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('[kubernetes-published-capacity-gate] capacity artifacts must remain inside the repository');
  }
  return { ...provider, mode, capacity, artifactsDir };
}

export function redactPublishedCapacityGateConfig(config) {
  return {
    version: 1,
    mode: config.mode,
    context: config.context,
    namespace: config.namespace,
    release: config.release,
    baseUrl: config.baseUrl,
    images: Object.fromEntries(
      Object.entries(config.images).map(([name, image]) => [name, `${image.repository}@${image.digest}`]),
    ),
    capacity: config.capacity,
  };
}
