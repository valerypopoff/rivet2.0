import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

export function readRepoFile(relativePath: string): string {
  return fs.readFileSync(new URL(`../../../../../${relativePath}`, import.meta.url), 'utf8');
}

export function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(readRepoFile(relativePath)) as T;
}

export function repoFileExists(relativePath: string): boolean {
  return fs.existsSync(new URL(`../../../../../${relativePath}`, import.meta.url));
}

export function expectRepoFileMissing(relativePath: string): void {
  assert.equal(repoFileExists(relativePath), false, `${relativePath} should not exist`);
}

export function extractBracedBlock(source: string, startPattern: RegExp): string {
  startPattern.lastIndex = 0;
  const startMatch = startPattern.exec(source);
  assert.ok(startMatch?.index != null, `Expected block matching ${startPattern} to exist`);

  const matchedBraceOffset = startMatch[0].lastIndexOf('{');
  const openBraceIndex = matchedBraceOffset >= 0
    ? startMatch.index + matchedBraceOffset
    : source.indexOf('{', startMatch.index);
  assert.notEqual(openBraceIndex, -1, `Expected block matching ${startPattern} to have an opening brace`);

  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startMatch.index, index + 1);
      }
    }
  }

  throw new Error(`Expected block matching ${startPattern} to have a closing brace`);
}
