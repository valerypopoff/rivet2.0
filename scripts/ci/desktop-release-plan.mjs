import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDiffCommits, listChangedPaths } from './ci-change-policy.mjs';

const fullSha = /^[a-f0-9]{40}$/i;
const onlyDocs = (paths) => paths.every((file) => file.startsWith('packages/docs/'));

/** A docs push cannot discard an unpublished application change from an earlier
 * push. Reuse requires both the event range AND the published-baseline range. */
export async function desktopReleasePlan({ cwd, eventName, event, sha, channel, allowDocsOnly, siteUrl }) {
  if (!fullSha.test(sha ?? '') || !['developer', 'official'].includes(channel))
    throw Error('Desktop release planning requires an exact commit and known channel.');
  const full = (reason) => ({ native: true, desktopCommit: '', reason });
  if (!allowDocsOnly || eventName !== 'push' || !fullSha.test(event.before ?? '') || /^0+$/.test(event.before))
    return full('Native build requested or no complete push range is available.');
  if (event.after !== sha) throw Error('Desktop release push identity does not match its checkout.');
  try {
    ensureDiffCommits(event.before, sha, cwd);
    const changed = listChangedPaths(event.before, sha, cwd);
    if (!changed.length || !onlyDocs(changed)) return full('The push includes non-documentation inputs.');
    const response = await fetch(new URL(`${channel}-release.json`, siteUrl), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return full('No confirmed published desktop baseline is available.');
    const metadata = await response.json();
    if (
      metadata.channel !== channel ||
      !fullSha.test(metadata.commit ?? '') ||
      !Array.isArray(metadata.stableDownloads) ||
      !metadata.stableDownloads.length
    )
      return full('Published desktop metadata is incomplete.');
    ensureDiffCommits(metadata.commit, sha, cwd);
    if (!onlyDocs(listChangedPaths(metadata.commit, sha, cwd)))
      return full('Non-documentation changes have not been published as desktop installers.');
    return {
      native: false,
      desktopCommit: metadata.commit,
      reason: 'Only documentation differs from the published desktop.',
    };
  } catch {
    // Uncertain classification means full verification/build, never fewer gates.
    return full('Published baseline comparison was unavailable; retaining the full native build.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = await desktopReleasePlan({
    cwd: process.cwd(),
    eventName: process.env.GITHUB_EVENT_NAME,
    event: process.env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {},
    sha: process.env.GITHUB_SHA,
    channel: process.env.RELEASE_CHANNEL,
    allowDocsOnly: process.env.ALLOW_DOCS_ONLY === 'true',
    siteUrl: process.env.PAGES_SITE_URL,
  });
  const output = `native=${plan.native}\ndesktop_commit=${plan.desktopCommit}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  console.log(`[desktop-release-plan] ${plan.reason}`);
}
