import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = resolve(docsDirectory, 'build');
const require = createRequire(import.meta.url);
const { baseUrl } = require('../docusaurus.config.js');
const normalizedBaseUrl = baseUrl.replace(/\/?$/, '/');

const searchIndexFilenames = (await readdir(buildDirectory)).filter((filename) =>
  /^search-index-[a-f0-9]+\.json$/i.test(filename),
);

assert.equal(
  searchIndexFilenames.length,
  1,
  'The production docs build must emit exactly one content-hashed local-search index.',
);

const searchIndex = JSON.parse(await readFile(resolve(buildDirectory, searchIndexFilenames[0]), 'utf8'));
const indexedDocuments = searchIndex.flatMap((entry) => entry.documents ?? []);

assert.ok(indexedDocuments.length > 0, 'The local-search index must contain documentation entries.');
assert.ok(
  indexedDocuments.some((document) => document.u === `${normalizedBaseUrl}node-reference/subgraph`),
  'The local-search index must include root-routed documentation pages under the configured site base URL.',
);

await readFile(resolve(buildDirectory, 'search.html'));

console.log(
  `Docs search bundle is valid: ${indexedDocuments.length} indexed entries in ${searchIndexFilenames[0]}.`,
);
