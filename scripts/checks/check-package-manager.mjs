import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTALL_INSTRUCTIONS = `This repository uses the checked-in Yarn 4.17.1 release for dependency installation.

Run:
  corepack enable
  yarn install --immutable

Do not create an npm or pnpm lockfile in this monorepo.`;

export function validatePackageManagerUserAgent(userAgent) {
  const packageManager = userAgent?.trim().split(/\s+/, 1)[0]?.split('/', 1)[0]?.toLowerCase();

  if (packageManager === 'npm' || packageManager === 'pnpm') {
    return { ok: false, message: INSTALL_INSTRUCTIONS };
  }

  return { ok: true };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const result = validatePackageManagerUserAgent(process.env.npm_config_user_agent);
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
  }
}
