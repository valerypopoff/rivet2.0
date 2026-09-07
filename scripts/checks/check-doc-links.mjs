import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const markdownLinkPattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const externalTargetPattern = /^(?:https?:|mailto:|app:|file:|#)/i;

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function listCandidateDocs() {
  const output = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => file.endsWith('.md'))
    .filter((file) => !file.includes('/'))
    .concat(
      output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((file) => file.replaceAll('\\', '/'))
        .filter((file) => /^developer-docs\/.+\.md$/.test(file)),
    )
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

function stripFencedCodeBlocks(source) {
  return source.replace(/```[\s\S]*?```/g, '');
}

function normalizeTarget(rawTarget) {
  const withoutAnchor = rawTarget.replace(/#.*/, '');
  const unwrapped =
    withoutAnchor.startsWith('<') && withoutAnchor.endsWith('>') ? withoutAnchor.slice(1, -1) : withoutAnchor;

  try {
    return decodeURIComponent(unwrapped);
  } catch {
    return unwrapped;
  }
}

function isInsideRepo(absolutePath) {
  const relativePath = relative(repoRoot, absolutePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

const brokenLinks = [];

for (const file of listCandidateDocs()) {
  const absoluteFile = join(repoRoot, file);
  if (!existsSync(absoluteFile)) {
    continue;
  }

  const source = stripFencedCodeBlocks(readFileSync(absoluteFile, 'utf8'));
  const fileDir = dirname(absoluteFile);

  for (const match of source.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1];
    if (!rawTarget || externalTargetPattern.test(rawTarget)) {
      continue;
    }

    const target = normalizeTarget(rawTarget);
    if (!target) {
      continue;
    }

    const absoluteTarget = resolve(fileDir, target);
    if (!isInsideRepo(absoluteTarget) || !existsSync(absoluteTarget)) {
      brokenLinks.push(`${file}: broken local link ${rawTarget}`);
      continue;
    }

    if (statSync(absoluteTarget).isDirectory()) {
      continue;
    }
  }
}

if (brokenLinks.length > 0) {
  console.error('Broken local documentation links found:');
  for (const link of brokenLinks) {
    console.error(`- ${link}`);
  }
  process.exitCode = 1;
} else {
  console.log('Local documentation links are valid.');
}
