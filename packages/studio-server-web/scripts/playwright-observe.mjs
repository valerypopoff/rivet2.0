import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadDevEnv } from '../../../deploy/studio-server/scripts/lib/dev-env.mjs';

const rootDir = process.cwd();
const webDir = path.join(rootDir, 'packages', 'studio-server-web');
const playwrightConfigPath = path.join(webDir, 'playwright.observe.config.ts');
const reportDir = path.join(rootDir, 'artifacts', 'playwright', 'report');
const yarnPath = path.join(rootDir, '.yarn', 'releases', 'yarn-4.17.1.cjs');

function run(command, args, env, cwd = rootDir) {
  return new Promise((resolve, reject) => {
    const commandLine =
      process.platform === 'win32'
        ? [command, ...args.map((arg) => (/\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))].join(' ')
        : command;

    const child = process.platform === 'win32'
      ? spawn(commandLine, {
          cwd,
          env,
          stdio: 'inherit',
          shell: true,
        })
      : spawn(command, args, {
          cwd,
          env,
          stdio: 'inherit',
          shell: false,
        });

    child.on('error', reject);
    child.on('exit', (code) => {
      const exitCode = code == null ? 1 : code;
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${exitCode}: ${command} ${args.join(' ')}`));
      }
    });
  });
}

function usage() {
  console.log('Usage: yarn studio-server:ui:observe <test|debug|install|report> [playwright args...]');
}

function runPlaywright(args, env) {
  return run(
    process.execPath,
    [yarnPath, 'workspace', '@valerypopoff/rivet-studio-server-web', 'exec', 'playwright', ...args],
    env,
    rootDir,
  );
}

function getObserveEnv() {
  const { mergedEnv } = loadDevEnv(rootDir);
  const proxyPort = Number.parseInt(mergedEnv.RIVET_PORT ?? '8080', 10);

  if (!mergedEnv.PLAYWRIGHT_BASE_URL) {
    mergedEnv.PLAYWRIGHT_BASE_URL = `http://127.0.0.1:${Number.isFinite(proxyPort) ? proxyPort : 8080}`;
  }

  if (!mergedEnv.PLAYWRIGHT_SLOW_MO) {
    mergedEnv.PLAYWRIGHT_SLOW_MO = '300';
  }

  if (!mergedEnv.PLAYWRIGHT_HEADLESS) {
    mergedEnv.PLAYWRIGHT_HEADLESS = '0';
  }

  return mergedEnv;
}

async function main() {
  const mode = process.argv[2] ?? 'test';
  const passthroughArgs = process.argv.slice(3);

  if (['test', 'debug', 'install', 'report'].includes(mode) === false) {
    usage();
    process.exit(1);
  }

  const env = getObserveEnv();
  console.log(`[playwright-observe] Base URL: ${env.PLAYWRIGHT_BASE_URL}`);
  console.log(`[playwright-observe] Report dir: ${reportDir}`);

  switch (mode) {
    case 'install':
      await runPlaywright(['install', 'chromium'], env);
      break;

    case 'report':
      await runPlaywright(['show-report', reportDir], env);
      break;

    case 'debug':
      env.PWDEBUG = '1';
      await runPlaywright(['install', 'chromium'], env);
      await runPlaywright(['test', '-c', playwrightConfigPath, ...passthroughArgs], env);
      break;

    case 'test':
      await runPlaywright(['install', 'chromium'], env);
      await runPlaywright(['test', '-c', playwrightConfigPath, ...passthroughArgs], env);
      break;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
