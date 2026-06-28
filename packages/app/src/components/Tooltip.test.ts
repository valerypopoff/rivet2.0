import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tooltipSource = readFileSync(new URL('./Tooltip.tsx', import.meta.url), 'utf8');

test('shared tooltip formats generic Ctrl/Cmd shortcut labels before rendering string content', () => {
  assert.match(tooltipSource, /import \{ formatShortcutTextForPlatform \} from '\.\.\/utils\/keyboardShortcutLabels';/);
  assert.match(
    tooltipSource,
    /const renderedContent = typeof content === 'string' \? formatShortcutTextForPlatform\(content\) : content;/,
  );
  assert.match(tooltipSource, /<div className="box">\{renderedContent\}<\/div>/);
});
