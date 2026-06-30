export type MarkdownFoldingRange = {
  start: number;
  end: number;
};

export const MARKDOWN_FOLDING_LANGUAGES = ['markdown', 'prompt-interpolation-markdown'] as const;

const MARKDOWN_FOLDING_LANGUAGE_SET = new Set<string>(MARKDOWN_FOLDING_LANGUAGES);

type Heading = {
  level: number;
  line: number;
};

type Fence = {
  character: string;
  length: number;
  line: number;
};

export function shouldEnableMarkdownFolding(language: string | undefined): boolean {
  return language != null && MARKDOWN_FOLDING_LANGUAGE_SET.has(language);
}

export function getMarkdownFoldingRanges(text: string): MarkdownFoldingRange[] {
  const lines = text.split(/\r\n|\r|\n/);
  const ranges: MarkdownFoldingRange[] = [];
  const headingStack: Heading[] = [];
  let activeFence: Fence | undefined;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index] ?? '';

    if (activeFence) {
      if (isClosingFence(line, activeFence)) {
        pushRange(ranges, activeFence.line, lineNumber);
        activeFence = undefined;
      }
      continue;
    }

    const openingFence = getOpeningFence(line);
    if (openingFence) {
      activeFence = { ...openingFence, line: lineNumber };
      continue;
    }

    const headingLevel = getAtxHeadingLevel(line);
    if (headingLevel == null) {
      continue;
    }

    while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= headingLevel) {
      const heading = headingStack.pop()!;
      pushRange(ranges, heading.line, lineNumber - 1);
    }

    headingStack.push({ level: headingLevel, line: lineNumber });
  }

  while (headingStack.length > 0) {
    const heading = headingStack.pop()!;
    pushRange(ranges, heading.line, lines.length);
  }

  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function getAtxHeadingLevel(line: string): number | undefined {
  const match = /^(?: {0,3})(#{1,6})(?:\s|$)/.exec(line);
  return match ? match[1]!.length : undefined;
}

function getOpeningFence(line: string): Omit<Fence, 'line'> | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) {
    return undefined;
  }

  const marker = match[1]!;
  return {
    character: marker[0]!,
    length: marker.length,
  };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const marker = getClosingFence(line);
  return marker != null && marker.character === fence.character && marker.length >= fence.length;
}

function getClosingFence(line: string): Omit<Fence, 'line'> | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  if (!match) {
    return undefined;
  }

  const marker = match[1]!;
  return {
    character: marker[0]!,
    length: marker.length,
  };
}

function pushRange(ranges: MarkdownFoldingRange[], start: number, end: number): void {
  if (end > start) {
    ranges.push({ start, end });
  }
}
