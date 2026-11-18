import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The temporary picomatch advisory review covers build tools, never these
// execution dependency paths. Web serves compiled assets rather than Vite/ESLint.
const pnp = createRequire(import.meta.url)('pnpapi');
const pending = [
  'core',
  'node',
  'cli',
  'evaluations',
  'app-executor',
  'studio-server-api',
  'studio-server-shared',
  'studio-server-executor',
  'studio-server-bootstrap',
].map((workspace) => ({
  locator: pnp.findPackageLocator(fileURLToPath(new URL(`../../packages/${workspace}/package.json`, import.meta.url))),
  chain: [],
}));
// Qualification runs prepared source probes and the locked browser test runner.
// Its full workspace build graph remains available only during image building.
const web = createRequire(new URL('../../packages/studio-server-web/package.json', import.meta.url));
pending.push({ locator: pnp.findPackageLocator(web.resolve('@playwright/test')), chain: [] });
const visited = new Set();
while (pending.length) {
  const { locator, chain } = pending.pop();
  const key = `${locator.name}@${locator.reference}`;
  if (visited.has(key)) continue;
  visited.add(key);
  const nextChain = [...chain, key];
  assert.ok(
    !['picomatch', 'micromatch'].includes(locator.name),
    `Unreviewed execution path: ${nextChain.join(' -> ')}`,
  );
  const info = pnp.getPackageInformation(locator);
  const manifest = JSON.parse(readFileSync(join(info.packageLocation, 'package.json'), 'utf8'));
  // Follow actual execution edges, excluding workspace development tools.
  for (const name of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })) {
    const reference = info.packageDependencies.get(name);
    if (reference == null) continue;
    pending.push({
      locator: Array.isArray(reference) ? { name: reference[0], reference: reference[1] } : { name, reference },
      chain: nextChain,
    });
  }
}
console.log('Build glob packages remain outside SDK, execution and qualification dependencies.');
