import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function listFilesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFilesRecursively(path) : [path];
    }),
  );
  return nestedFiles.flat();
}

const docsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = resolve(docsDirectory, 'build');
const demoDirectory = resolve(buildDirectory, 'rivet-demo');
const require = createRequire(import.meta.url);
const { baseUrl, url } = require('../docusaurus.config.js');
const promoPublicPath = `${baseUrl.replace(/\/?$/, '/')}rivet-demo/`;
const publishedSiteUrl = new URL(baseUrl, url).href;
const publishedPromoUrl = new URL('rivet-demo/', publishedSiteUrl).href;
const landingHtml = await readFile(resolve(buildDirectory, 'index.html'), 'utf8');
const indexHtml = await readFile(resolve(demoDirectory, 'index.html'), 'utf8');

const expectedLandingIframeSources = ['agent', 'visual-code'].map(
  (projectId) => `${promoPublicPath}?project=${projectId}`,
);
const landingIframeSources = [...landingHtml.matchAll(/<iframe\b[^>]+src="([^"]+)"/g)].map((match) => match[1]);

assert.deepEqual(
  landingIframeSources,
  expectedLandingIframeSources,
  `The generated landing page must embed its initial Rivet editors from ${publishedPromoUrl}.`,
);
assert.match(
  landingHtml,
  /<iframe\b[^>]+sandbox="allow-same-origin allow-scripts allow-popups"/,
  'The generated landing page must allow its embedded promo editor to open detached web-app previews.',
);
assert.equal(landingHtml.includes('localhost'), false, 'The production landing page must not reference localhost.');
assert.equal(
  landingHtml.includes('.promo-dev'),
  false,
  'The production landing page must not reference development output.',
);
assert.doesNotMatch(
  landingHtml,
  /(?:src|href)="\/rivet-demo\//,
  `The production landing page must keep Rivet demo URLs under the GitHub Pages base path ${baseUrl}.`,
);
await readFile(resolve(buildDirectory, '.nojekyll'));

function resolvePromoAssetPath(assetUrl) {
  const pathname = new URL(assetUrl, 'https://rivet.invalid/').pathname;
  assert.ok(
    pathname.startsWith(promoPublicPath),
    `Promo entry asset "${assetUrl}" must stay under "${promoPublicPath}".`,
  );

  const path = resolve(demoDirectory, decodeURIComponent(pathname.slice(promoPublicPath.length)));
  const pathFromDemo = relative(demoDirectory, path);
  assert.ok(
    pathFromDemo !== '..' && !pathFromDemo.startsWith(`..\\`) && !pathFromDemo.startsWith('../'),
    `Promo entry asset "${assetUrl}" escapes the generated demo directory.`,
  );
  return path;
}

const initialAssetPaths = [...indexHtml.matchAll(/<(?:script|link)\b[^>]+(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((assetUrl) => /\.(?:css|js)(?:$|\?)/.test(assetUrl))
  .map(resolvePromoAssetPath);

assert.ok(initialAssetPaths.length > 0, 'The promo entry must reference built JS or CSS assets.');

const initialGzipBytes = (
  await Promise.all(initialAssetPaths.map(async (path) => gzipSync(await readFile(path)).byteLength))
).reduce((total, bytes) => total + bytes, 0);
const outputPaths = await listFilesRecursively(demoDirectory);
const monacoWorkerAssetPaths = outputPaths.filter((path) =>
  /(?:^|[\\/])(?:css|editor|html|json|ts)\.worker-[^\\/]+\.js$/.test(path),
);

assert.ok(monacoWorkerAssetPaths.length >= 5, 'The promo build must emit all five Monaco language worker assets.');

// Vite-native worker imports keep worker URLs inside compiled application code
// instead of injecting them into index.html. Reading each emitted asset guards
// against a publish layout that omits a lazily created language worker.
await Promise.all(monacoWorkerAssetPaths.map((path) => readFile(path)));

const totalAssetBytes = (await Promise.all(outputPaths.map(async (path) => (await readFile(path)).byteLength))).reduce(
  (total, bytes) => total + bytes,
  0,
);

const INITIAL_GZIP_BUDGET = 4 * 1024 * 1024;
const TOTAL_ASSET_BUDGET = 40 * 1024 * 1024;

assert.ok(
  initialGzipBytes <= INITIAL_GZIP_BUDGET,
  `Promo initial assets are ${(initialGzipBytes / 1024 / 1024).toFixed(2)} MiB gzip; budget is 4 MiB.`,
);
assert.ok(
  totalAssetBytes <= TOTAL_ASSET_BUDGET,
  `Promo output is ${(totalAssetBytes / 1024 / 1024).toFixed(2)} MiB; budget is 40 MiB.`,
);

console.log(
  `Promo bundle is within budget: ${(initialGzipBytes / 1024 / 1024).toFixed(2)} MiB initial gzip, ` +
    `${(totalAssetBytes / 1024 / 1024).toFixed(2)} MiB total assets. ` +
    `Landing embeds target ${publishedPromoUrl}.`,
);
