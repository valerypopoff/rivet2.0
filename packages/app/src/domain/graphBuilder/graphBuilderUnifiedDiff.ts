import { GRAPH_BUILDER_LIMITS } from './graphBuilderLimits.js';

export type GraphBuilderUnifiedDiffLine = {
  kind: 'context' | 'delete' | 'add';
  text: string;
  noNewline: boolean;
};

export type GraphBuilderUnifiedDiffHunk = Readonly<{
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: GraphBuilderUnifiedDiffLine[];
}>;

export type ParsedGraphBuilderUnifiedDiff = Readonly<{
  path: string;
  hunks: GraphBuilderUnifiedDiffHunk[];
}>;

export class GraphBuilderUnifiedDiffError extends Error {
  readonly path?: string;

  constructor(message: string, options: { path?: string } = {}) {
    super(message);
    this.name = 'GraphBuilderUnifiedDiffError';
    this.path = options.path;
  }
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const utf8Encoder = new TextEncoder();

export function isNormalizedGraphBuilderVirtualDocumentPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= GRAPH_BUILDER_LIMITS.maxSettingPathLength &&
    value.trim() === value &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !value.includes('\\') &&
    !value.includes('\t') &&
    value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

function parseHeaderPath(rawPath: string, prefix: 'a/' | 'b/'): string {
  const path = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
  if (!isNormalizedGraphBuilderVirtualDocumentPath(path)) {
    throw new GraphBuilderUnifiedDiffError(
      `Unified diff header path "${rawPath}" is not a normalized relative virtual-document path.`,
    );
  }
  return path;
}

function parseNonNegativeInteger(raw: string | undefined, label: string, path?: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GraphBuilderUnifiedDiffError(
      `Unified diff ${label} must be a non-negative safe integer.`,
      path === undefined ? {} : { path },
    );
  }
  return value;
}

/**
 * Parses the exact one-file unified-diff dialect accepted by Graph Builder.
 *
 * This is the single grammar seam shared by the model-facing decision schema
 * and the virtual workspace. It deliberately validates syntax only; exact
 * source context is checked later while applying the parsed hunks.
 */
export function parseGraphBuilderUnifiedDiff(unifiedDiff: string): ParsedGraphBuilderUnifiedDiff {
  if (
    typeof unifiedDiff !== 'string' ||
    unifiedDiff.length === 0 ||
    utf8Encoder.encode(unifiedDiff).byteLength > GRAPH_BUILDER_LIMITS.maxPortableBytes
  ) {
    throw new GraphBuilderUnifiedDiffError(
      `Unified diff must be non-empty and no larger than ${GRAPH_BUILDER_LIMITS.maxPortableBytes} bytes.`,
    );
  }
  if (/\r(?!\n)/u.test(unifiedDiff)) {
    throw new GraphBuilderUnifiedDiffError('Unified diff must use LF or CRLF line endings.');
  }

  const lines = unifiedDiff.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length < 4 || !lines[0]?.startsWith('--- ') || !lines[1]?.startsWith('+++ ')) {
    throw new GraphBuilderUnifiedDiffError(
      'Unified diff must begin with exactly one ---/+++ virtual file header pair.',
    );
  }

  const oldPath = parseHeaderPath(lines[0]!.slice(4), 'a/');
  const newPath = parseHeaderPath(lines[1]!.slice(4), 'b/');
  if (oldPath !== newPath) {
    throw new GraphBuilderUnifiedDiffError(
      'Unified diff old and new headers must identify the same virtual graph document.',
    );
  }

  const hunks: GraphBuilderUnifiedDiffHunk[] = [];
  let lineIndex = 2;
  let changedLineCount = 0;
  while (lineIndex < lines.length) {
    const header = lines[lineIndex]!;
    const match = hunkHeaderPattern.exec(header);
    if (!match) {
      throw new GraphBuilderUnifiedDiffError(`Unified diff has an invalid hunk header at line ${lineIndex + 1}.`, {
        path: oldPath,
      });
    }
    const oldStart = parseNonNegativeInteger(match[1], 'old hunk start', oldPath);
    const oldCount = parseNonNegativeInteger(match[2] ?? '1', 'old hunk count', oldPath);
    const newStart = parseNonNegativeInteger(match[3], 'new hunk start', oldPath);
    const newCount = parseNonNegativeInteger(match[4] ?? '1', 'new hunk count', oldPath);
    if ((oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)) {
      throw new GraphBuilderUnifiedDiffError(
        `Unified diff hunk starts must be positive unless their corresponding line count is zero.`,
        { path: oldPath },
      );
    }
    lineIndex += 1;
    const hunkLines: GraphBuilderUnifiedDiffLine[] = [];
    let observedOld = 0;
    let observedNew = 0;

    while (lineIndex < lines.length && (observedOld < oldCount || observedNew < newCount)) {
      const line = lines[lineIndex]!;
      if (line === '\\ No newline at end of file') {
        const previous = hunkLines.at(-1);
        if (!previous || previous.noNewline) {
          throw new GraphBuilderUnifiedDiffError(
            `Unified diff has a misplaced no-newline marker at line ${lineIndex + 1}.`,
            { path: oldPath },
          );
        }
        previous.noNewline = true;
        lineIndex += 1;
        continue;
      }
      const marker = line[0];
      const text = line.slice(1);
      if (marker === ' ') {
        observedOld += 1;
        observedNew += 1;
        hunkLines.push({ kind: 'context', text, noNewline: false });
      } else if (marker === '-') {
        observedOld += 1;
        changedLineCount += 1;
        hunkLines.push({ kind: 'delete', text, noNewline: false });
      } else if (marker === '+') {
        observedNew += 1;
        changedLineCount += 1;
        hunkLines.push({ kind: 'add', text, noNewline: false });
      } else {
        throw new GraphBuilderUnifiedDiffError(`Unified diff has an invalid body line at line ${lineIndex + 1}.`, {
          path: oldPath,
        });
      }
      if (observedOld > oldCount || observedNew > newCount) {
        throw new GraphBuilderUnifiedDiffError(`Unified diff hunk counts overflow at line ${lineIndex + 1}.`, {
          path: oldPath,
        });
      }
      lineIndex += 1;
    }

    if (lineIndex < lines.length && lines[lineIndex] === '\\ No newline at end of file') {
      const previous = hunkLines.at(-1);
      if (!previous || previous.noNewline) {
        throw new GraphBuilderUnifiedDiffError(
          `Unified diff has a misplaced no-newline marker at line ${lineIndex + 1}.`,
          { path: oldPath },
        );
      }
      previous.noNewline = true;
      lineIndex += 1;
    }
    if (observedOld !== oldCount || observedNew !== newCount) {
      throw new GraphBuilderUnifiedDiffError(
        `Unified diff hunk ending at line ${lineIndex} does not match its declared line counts.`,
        { path: oldPath },
      );
    }
    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    });
  }

  if (hunks.length === 0 || changedLineCount === 0) {
    throw new GraphBuilderUnifiedDiffError('Unified diff must contain at least one changed line.', { path: oldPath });
  }
  return { path: oldPath, hunks };
}
