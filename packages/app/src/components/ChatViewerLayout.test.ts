import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

test('chat viewer uses document-flow rows and deliberate status styling', () => {
  const chatViewerSource = readFileSync(join(srcDir, 'ChatViewer.tsx'), 'utf8');

  assert.doesNotMatch(chatViewerSource, /FixedSizeList|itemSize=\{150\}/);
  assert.match(chatViewerSource, /content-visibility: auto;/);
  assert.match(chatViewerSource, /'status-ok': data\.status\?\.type === 'ok'/);
  assert.match(chatViewerSource, /'status-not-ran': data\.status\?\.type === 'notRan'/);
  assert.match(chatViewerSource, /&\.status-not-ran \{[\s\S]*border-style: dashed;/);
  assert.match(chatViewerSource, /process\.data\.finishedAt \?\? process\.data\.startedAt \?\? 0,\s+'asc'/);
  assert.doesNotMatch(chatViewerSource, /runningProcesses|completedProcesses|graphRunningState/);
  assert.match(chatViewerSource, /className="empty-state"/);
  assert.match(chatViewerSource, /\.chat-title \{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(chatViewerSource, /\.buttons \{[\s\S]*flex-shrink: 0;/);
  assert.match(chatViewerSource, /aria-label=\{expanded \? 'Collapse chat output' : 'Expand chat output'\}/);
});
