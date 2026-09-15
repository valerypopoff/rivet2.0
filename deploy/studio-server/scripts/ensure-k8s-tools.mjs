import path from 'node:path';
import { installCachedHelm, resolveHelmBin } from './lib/k8s-tools.mjs';

const rootDir = process.cwd();

async function main() {
  const existing = resolveHelmBin(rootDir);
  if (existing) {
    console.log(`[setup:k8s-tools] Helm ready from ${existing.source} at ${existing.bin}`);
    return;
  }

  const cachedHelm = await installCachedHelm(rootDir);
  console.log(`[setup:k8s-tools] Cached Helm ready at ${path.relative(rootDir, cachedHelm)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
