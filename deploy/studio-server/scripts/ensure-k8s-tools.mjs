import path from 'node:path';
import { installCachedHelm, resolveHelmBin } from './lib/k8s-tools.mjs';

const rootDir = process.cwd();

async function main() {
  const existing = resolveHelmBin(rootDir);
  const cachedHelm = await installCachedHelm(rootDir);

  console.log(`[setup:k8s-tools] Cached Helm ready at ${path.relative(rootDir, cachedHelm)}`);
  if (existing?.source === 'env') {
    console.log(`[setup:k8s-tools] RIVET_K8S_HELM_BIN is set, so that explicit override will still win at runtime.`);
  } else if (existing?.source === 'path') {
    console.log(`[setup:k8s-tools] System Helm is available at ${existing.bin}; PATH will still win before the cached copy.`);
  } else {
    console.log('[setup:k8s-tools] No explicit or system Helm was detected; launcher and verification flows will use the cached copy.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
