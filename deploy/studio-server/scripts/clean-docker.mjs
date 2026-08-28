import { run } from './lib/docker-launcher.mjs';

const rootDir = process.cwd();
const env = process.env;

async function main() {
  console.log('[clean] Docker-host cleanup: stopped containers, unused networks/images, and build cache may be removed for any project on this Docker host.');
  console.log('[clean] Docker volumes are preserved.');

  console.log('[clean] Docker disk usage before cleanup:');
  await run('docker system df', env, { cwd: rootDir, allowFailure: true });

  console.log('[clean] Removing stopped containers...');
  await run('docker container prune -f', env, { cwd: rootDir });

  console.log('[clean] Removing unused networks...');
  await run('docker network prune -f', env, { cwd: rootDir });

  console.log('[clean] Removing unused images...');
  await run('docker image prune -a -f', env, { cwd: rootDir });

  console.log('[clean] Removing BuildKit cache...');
  await run('docker builder prune -a -f', env, { cwd: rootDir });

  console.log('[clean] Docker disk usage after cleanup:');
  await run('docker system df', env, { cwd: rootDir, allowFailure: true });

  console.log('[clean] Done. Docker volumes were not pruned.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
