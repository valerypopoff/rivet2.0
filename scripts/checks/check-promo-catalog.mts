import assert from 'node:assert/strict';
import { PROMO_PROJECT_MANIFEST, type PromoProjectKey } from '../../packages/app/src/promo/promoProjectManifest.js';
import { homepageContent } from '../../packages/docs/src/content/homepageContent.js';

const expectedHomepageDemoOrder = [
  'agent',
  'workflow',
  'web-app',
  'visual-code',
] as const satisfies readonly PromoProjectKey[];

assert.deepEqual(
  homepageContent.demos.map((demo) => demo.demoId),
  expectedHomepageDemoOrder,
  'The documentation demo catalog must keep the intended section order.',
);
assert.deepEqual(
  homepageContent.hero.features.map((demo) => demo.demoId),
  expectedHomepageDemoOrder.slice(0, 3),
  'The hero must default to Agent and switch among Agent, Workflow, and Web App in that order.',
);
assert.equal(homepageContent.foundationsDemo.demoId, 'visual-code', 'Foundations must own the fixed visual-code demo.');
assert.deepEqual(
  [...homepageContent.hero.features.map((demo) => demo.demoId), homepageContent.foundationsDemo.demoId],
  expectedHomepageDemoOrder,
  'Every section-owned demo must map to exactly one intended homepage placement.',
);
assert.deepEqual(
  homepageContent.demos.map((demo) => demo.demoId).sort(),
  Object.keys(PROMO_PROJECT_MANIFEST).sort(),
  'The documentation demo catalog and the promo-host project catalog must expose the same IDs.',
);

console.log('Promo homepage placement and promo-host project catalogs are in sync.');
