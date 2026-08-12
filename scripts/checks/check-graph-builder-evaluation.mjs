import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseGraphBuilderDevelopmentFixtureSet,
  parseGraphBuilderEvaluationAssetManifest,
  parseGraphBuilderEvaluationPolicy,
  parseGraphBuilderHiddenHoldoutContract,
} from '../../packages/app/src/features/graphBuilder/evaluation/contracts.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const defaultGraphBuilderEvaluationFixtureDirectory = path.join(
  repoRoot,
  'packages/app/src/features/graphBuilder/evaluation/fixtures',
);

export async function validateGraphBuilderEvaluationAssets({
  fixtureDirectory = defaultGraphBuilderEvaluationFixtureDirectory,
  write = false,
} = {}) {
  const manifestPath = path.join(fixtureDirectory, 'manifest.v1.json');
  let manifestSource = JSON.parse(await readFile(manifestPath, 'utf8'));
  let manifest = parseGraphBuilderEvaluationAssetManifest(manifestSource);
  const assetKinds = new Set(manifest.assets.map((asset) => asset.kind));
  if (assetKinds.size !== manifest.assets.length) {
    throw new Error('Graph Builder evaluation manifest contains a duplicate asset kind.');
  }

  const loadedAssets = new Map();
  const refreshedAssets = [];
  for (const asset of manifest.assets) {
    const assetPath = resolveContainedAssetPath(fixtureDirectory, asset.path);
    const source = await readFile(assetPath, 'utf8');
    const sha256 = hashEvaluationAsset(source);
    if (!write && sha256 !== asset.sha256) {
      throw new Error(
        `Graph Builder evaluation asset is stale: ${asset.path}. Expected ${asset.sha256}, received ${sha256}. ` +
          'Run "yarn check:graph-builder-evaluation --write" after an intentional fixture or policy change.',
      );
    }
    loadedAssets.set(asset.kind, JSON.parse(source));
    refreshedAssets.push({ ...asset, sha256 });
  }

  const policy = parseGraphBuilderEvaluationPolicy(requireAsset(loadedAssets, 'policy'));
  const fixtureSet = parseGraphBuilderDevelopmentFixtureSet(requireAsset(loadedAssets, 'development-fixtures'));
  const hiddenHoldout = parseGraphBuilderHiddenHoldoutContract(requireAsset(loadedAssets, 'hidden-holdout-contract'));
  validateEvaluationInvariants({ policy, fixtureSet, hiddenHoldout });
  await validateConcreteRuntimeSeams();

  if (write) {
    manifestSource = {
      ...manifestSource,
      fixtureCount: fixtureSet.fixtures.length,
      assets: refreshedAssets,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifestSource, null, 2)}\n`, 'utf8');
    manifest = parseGraphBuilderEvaluationAssetManifest(manifestSource);
  }

  if (manifest.fixtureCount !== fixtureSet.fixtures.length) {
    throw new Error(
      `Graph Builder evaluation fixture count is stale: manifest=${manifest.fixtureCount}, ` +
        `actual=${fixtureSet.fixtures.length}.`,
    );
  }

  return {
    manifest,
    policy,
    fixtureSet,
    hiddenHoldout,
  };
}

export function hashEvaluationAsset(source) {
  const canonicalSource = source.replace(/\r\n?/g, '\n');
  return `sha256:${createHash('sha256').update(canonicalSource, 'utf8').digest('hex')}`;
}

async function validateConcreteRuntimeSeams() {
  const [adapters, planBHook, legacyHook] = await Promise.all([
    readFile(path.join(repoRoot, 'packages/app/src/features/graphBuilder/evaluation/runtimeAdapters.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'packages/app/src/hooks/usePlanBGraphBuilder.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'packages/app/src/hooks/useAiGraphBuilder.ts'), 'utf8'),
  ]);

  if (!adapters.includes('runLegacyGraphBuilderDraft') || !adapters.includes('createPlanBGraphBuilderSessionRuntime')) {
    throw new Error('Graph Builder evaluation adapters must invoke the shared production host runtimes.');
  }
  if (!planBHook.includes('createPlanBGraphBuilderSessionRuntime')) {
    throw new Error('Production Plan B must use the same host runtime as Graph Builder evaluation.');
  }
  if (!legacyHook.includes('runLegacyGraphBuilderDraft')) {
    throw new Error('Production hardened legacy must use the same private-draft runtime as Graph Builder evaluation.');
  }
}

function validateEvaluationInvariants({ policy, fixtureSet, hiddenHoldout }) {
  if (hiddenHoldout.status === 'placeholder' && hiddenHoldout.protectedManifestSha256 !== null) {
    throw new Error('Placeholder Graph Builder hidden holdout must not claim a protected manifest hash.');
  }
  if (hiddenHoldout.status === 'bound' && hiddenHoldout.protectedManifestSha256 === null) {
    throw new Error('Bound Graph Builder hidden holdout must identify the protected manifest hash.');
  }

  const globalCanaryIds = new Set();
  const globalCanaryValues = new Set();
  for (const fixture of fixtureSet.fixtures) {
    if (fixture.cohort === 'phase-8-expected-unsupported') {
      if (
        fixture.expectation.nodes.rules.length !== 0 ||
        fixture.expectation.nodes.exactTotal !== null ||
        fixture.expectation.connections.rules.length !== 0 ||
        fixture.expectation.connections.exactTotal !== null
      ) {
        throw new Error(`Phase-8 fixture "${fixture.id}" must not describe a mutated target graph.`);
      }
    }
    for (const canary of fixture.syntheticCanaries) {
      if (globalCanaryIds.has(canary.id) || globalCanaryValues.has(canary.value)) {
        throw new Error(`Synthetic canary "${canary.id}" is not globally unique.`);
      }
      globalCanaryIds.add(canary.id);
      globalCanaryValues.add(canary.value);
    }
  }

  const phase8Threshold = policy.cohortThresholds['phase-8-expected-unsupported'];
  if (
    phase8Threshold.minimumStructuralScore !== 1 ||
    phase8Threshold.minimumSafetyGateRate !== 1 ||
    phase8Threshold.minimumSuccessfulFixtureRate !== 1 ||
    phase8Threshold.maximumRegressionFromHardenedLegacy !== 0
  ) {
    throw new Error('Phase-8 Graph Builder evaluation thresholds must require truthful unsupported behavior.');
  }
  if (!policy.comparison.requireAllHardSafetyGates) {
    throw new Error('Graph Builder evaluation policy must require every hard safety gate.');
  }
}

function resolveContainedAssetPath(fixtureDirectory, relativePath) {
  if (path.basename(relativePath) !== relativePath || relativePath.includes('\\')) {
    throw new Error(`Graph Builder evaluation asset path must be a local POSIX basename: ${relativePath}`);
  }
  const resolved = path.resolve(fixtureDirectory, relativePath);
  const relative = path.relative(fixtureDirectory, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Graph Builder evaluation asset escapes the fixture directory: ${relativePath}`);
  }
  return resolved;
}

function requireAsset(assets, kind) {
  const asset = assets.get(kind);
  if (asset === undefined) {
    throw new Error(`Graph Builder evaluation manifest is missing the "${kind}" asset.`);
  }
  return asset;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const write = process.argv.slice(2).includes('--write');
  validateGraphBuilderEvaluationAssets({ write })
    .then(({ fixtureSet, policy, hiddenHoldout }) => {
      console.log(
        `Graph Builder evaluation assets are valid: ${fixtureSet.fixtures.length} development fixtures, ` +
          `policy ${policy.policyVersion}, hidden holdout ${hiddenHoldout.status}.`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
