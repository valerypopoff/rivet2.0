import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import developmentFixtures from '../../packages/app/src/features/graphBuilder/evaluation/fixtures/development-fixtures.v1.json' with { type: 'json' };
import {
  defaultGraphBuilderEvaluationFixtureDirectory,
  validateGraphBuilderEvaluationAssets,
} from './check-graph-builder-evaluation.mjs';

test('checked Graph Builder evaluation assets are fresh and cover every cohort', async () => {
  const result = await validateGraphBuilderEvaluationAssets();

  assert.ok(result.fixtureSet.fixtures.length >= 20);
  assert.deepEqual(
    new Set(result.fixtureSet.fixtures.map((fixture) => fixture.cohort)),
    new Set([
      'supported-core-authoring',
      'supported-contextual-authoring',
      'supported-host-safety',
      'phase-8-expected-unsupported',
    ]),
  );
  assert.equal(result.hiddenHoldout.inputsIncluded, false);
  assert.equal(result.hiddenHoldout.protectedManifestSha256, null);
});

test('freshness check detects drift and write mode refreshes only the public manifest', async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'rivet-graph-builder-evaluation-'));
  const fixtureDirectory = path.join(temporaryRoot, 'fixtures');
  try {
    await cp(defaultGraphBuilderEvaluationFixtureDirectory, fixtureDirectory, { recursive: true });
    const fixturePath = path.join(fixtureDirectory, 'development-fixtures.v1.json');
    const fixtureSource = structuredClone(developmentFixtures);
    fixtureSource.fixtures[0].request = `${fixtureSource.fixtures[0].request} Intentional drift.`;
    await writeFile(fixturePath, `${JSON.stringify(fixtureSource, null, 2)}\n`, 'utf8');

    await assert.rejects(
      validateGraphBuilderEvaluationAssets({ fixtureDirectory }),
      /Graph Builder evaluation asset is stale/,
    );
    await validateGraphBuilderEvaluationAssets({ fixtureDirectory, write: true });
    await validateGraphBuilderEvaluationAssets({ fixtureDirectory });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
