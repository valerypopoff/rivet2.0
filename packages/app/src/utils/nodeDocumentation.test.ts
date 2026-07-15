import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuiltInRegistry, type BuiltInNodeType } from '@valerypopoff/rivet2-core';
import {
  BUILT_IN_NODE_DOCUMENTATION_SLUGS,
  getBuiltInNodeDocumentationUrl,
  INTERNAL_BUILT_IN_NODE_TYPES_WITHOUT_NODE_REFERENCE,
  NODE_REFERENCE_BASE_URL,
} from './nodeDocumentation.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(srcDir, '..', '..', '..', '..');
const docsNodeReferenceDir = join(repoRoot, 'packages', 'docs', 'docs', 'node-reference');
const docsNodeReferenceIndexPath = join(docsNodeReferenceDir, 'all-nodes.mdx');
const docsSidebarPath = join(repoRoot, 'packages', 'docs', 'sidebars.js');

function getDocSourceFileName(slug: string): string {
  return slug.toLowerCase() === 'rng' ? 'rng.mdx' : `${slug}.mdx`;
}

function getDocSourceLink(slug: string): string {
  return `./${getDocSourceFileName(slug)}`;
}

function getFrontmatterId(source: string): string | undefined {
  return source
    .match(/^id:\s*(.+)$/m)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
}

test('every built-in node type has a specific Node Reference URL', () => {
  const builtInTypes = (createBuiltInRegistry().getNodeTypes() as BuiltInNodeType[]).filter(
    (nodeType) => !INTERNAL_BUILT_IN_NODE_TYPES_WITHOUT_NODE_REFERENCE.has(nodeType),
  );
  const mappedTypes = Object.keys(BUILT_IN_NODE_DOCUMENTATION_SLUGS).sort();
  const slugs = Object.values(BUILT_IN_NODE_DOCUMENTATION_SLUGS);

  assert.deepEqual(mappedTypes, [...builtInTypes].sort());
  assert.equal(new Set(slugs).size, slugs.length);

  for (const nodeType of builtInTypes) {
    const slug = (BUILT_IN_NODE_DOCUMENTATION_SLUGS as Record<string, string | undefined>)[nodeType];
    assert.ok(slug);

    const url = getBuiltInNodeDocumentationUrl(nodeType);
    assert.equal(url, `${NODE_REFERENCE_BASE_URL}/${slug}`);
  }
});

test('built-in node documentation URLs point at checked-in Node Reference pages', () => {
  const missingSlugs: string[] = [];

  for (const slug of Object.values(BUILT_IN_NODE_DOCUMENTATION_SLUGS)) {
    const sourcePath = join(docsNodeReferenceDir, getDocSourceFileName(slug));
    if (!existsSync(sourcePath)) {
      missingSlugs.push(slug);
      continue;
    }

    const frontmatterId = getFrontmatterId(readFileSync(sourcePath, 'utf8'));
    if (frontmatterId !== undefined) {
      assert.equal(frontmatterId, slug);
    }
  }

  assert.deepEqual(missingSlugs, []);
});

test('Match uses the Regex Match public documentation route', () => {
  assert.equal(getBuiltInNodeDocumentationUrl('match'), `${NODE_REFERENCE_BASE_URL}/regex-match`);
});

test('built-in node documentation pages are linked from the Node Reference index and sidebar', () => {
  const sidebar = readFileSync(docsSidebarPath, 'utf8');
  const allNodesIndex = readFileSync(docsNodeReferenceIndexPath, 'utf8');
  const slugs = Object.values(BUILT_IN_NODE_DOCUMENTATION_SLUGS);

  const missingSidebarSlugs = slugs.filter((slug) => !sidebar.includes(`node-reference/${slug}`));
  const missingIndexSlugs = slugs.filter((slug) => !allNodesIndex.includes(getDocSourceLink(slug)));

  assert.deepEqual({ missingSidebarSlugs, missingIndexSlugs }, { missingSidebarSlugs: [], missingIndexSlugs: [] });
});

test('unknown and plugin node types do not get built-in Node Reference links', () => {
  assert.equal(getBuiltInNodeDocumentationUrl('plugin:example'), undefined);
  assert.equal(getBuiltInNodeDocumentationUrl('missing-node-type'), undefined);
  assert.equal(getBuiltInNodeDocumentationUrl('nodePrefabInstance'), undefined);
  assert.equal(getBuiltInNodeDocumentationUrl('toString'), undefined);
});
