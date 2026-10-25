import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findImportEdges,
  findRuntimeDependencyPath,
  edgeKey,
  isPackageDeepImport,
  reviewImportDebt,
} from './import-boundaries.mjs';

test('dependency ratchet recognizes actual multiline and dynamic imports, not comments or code strings', () => {
  const code = `// import x from '../../../ignored';
    const authored = "import x from '../../../ignored-too'";
    import type { X } from
      '../../../existing';
    export { Y } from '../../../export';
    const dynamic = import('@valerypopoff/rivet2-core/src/private');
    type Z = import('../../../type').Z;
    require('../../../required');`;
  const edges = findImportEdges('packages/demo/src/consumer.ts', code);
  assert.deepEqual(
    edges.map((e) => e.specifier),
    [
      '../../../existing',
      '../../../export',
      '@valerypopoff/rivet2-core/src/private',
      '../../../type',
      '../../../required',
    ],
  );
  assert.equal(edges.filter(isPackageDeepImport).length, 1);
  const allowed = edges.map(edgeKey).filter((key) => !key.includes('@valerypopoff'));
  assert.deepEqual(reviewImportDebt(findImportEdges(edges[0].file, '\n\n' + code), allowed), {
    added: [],
    removed: [],
    duplicates: [],
  });
  const changed = [...edges.slice(1), { file: edges[0].file, specifier: '../../../new', line: 1 }];
  const review = reviewImportDebt(changed, allowed);
  assert.deepEqual(review.added, [edgeKey(changed.at(-1))]);
  assert.deepEqual(review.removed, [edgeKey(edges[0])]);
  assert.deepEqual(reviewImportDebt(edges, [...allowed, allowed[0]]).duplicates, [allowed[0]]);
});

test('engine namespace boundary rejects indirect runtime barrel dependencies but allows erased types', () => {
  const start = 'packages/core/src/integrations/CodeRunner.ts';
  const targets = new Set(['packages/core/src/exports.ts']);
  const leaf = findImportEdges(
    'packages/core/src/integrations/namespace.ts',
    "import type * as API from '../exports.js';",
  );
  const runner = findImportEdges(start, "import { get } from './namespace.js';");
  assert.equal(findRuntimeDependencyPath([...runner, ...leaf], start, targets), undefined);
  const runtime = findImportEdges(leaf[0].file, "export * from '../exports.js';");
  const selfImport = findImportEdges(start, "import * as Rivet from '@valerypopoff/rivet2-core';");
  assert.deepEqual(
    findRuntimeDependencyPath(selfImport, start, targets, {
      '@valerypopoff/rivet2-core': 'packages/core/src/exports.ts',
    }),
    [start, ...targets],
  );
  assert.deepEqual(findRuntimeDependencyPath([...runner, ...runtime], start, targets), [
    start,
    leaf[0].file,
    ...targets,
  ]);
});
