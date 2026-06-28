import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('wire layer stays clipped to the canvas box for embedded iframe hosts', () => {
  const source = readFileSync(join(componentsDir, 'WireLayer.tsx'), 'utf8');
  const wireStyles = /const wiresStyles = css`(?<styles>[\s\S]*?)`;/u.exec(source)?.groups?.styles;

  assert.ok(wireStyles, 'Expected WireLayer styles to stay local to wiresStyles');
  assert.match(wireStyles, /position: absolute;/);
  assert.match(wireStyles, /inset: 0;/);
  assert.doesNotMatch(wireStyles, /overflow:\s*visible;/);
});

test('wire hover uses transparent rendered-wire hit paths instead of global curve hit testing', () => {
  const wireLayerSource = readFileSync(join(componentsDir, 'WireLayer.tsx'), 'utf8');
  const wireSource = readFileSync(join(componentsDir, 'Wire.tsx'), 'utf8');
  const wireStyles = /const wiresStyles = css`(?<styles>[\s\S]*?)`;/u.exec(wireLayerSource)?.groups?.styles;

  assert.ok(wireStyles, 'Expected WireLayer styles to stay local to wiresStyles');
  assert.match(wireStyles, /\.wire-hit-area/);
  assert.match(wireStyles, /pointer-events:\s*stroke;/);
  assert.match(wireStyles, /stroke:\s*transparent;/);
  assert.match(wireStyles, /vector-effect:\s*non-scaling-stroke;/);
  assert.match(wireLayerSource, /const \[hoveredConnectionKey, setHoveredConnectionKey\] = useState<string \| undefined>\(\);/);
  assert.match(wireLayerSource, /getProjectConnectionComparisonKey\(connection\) === hoveredConnectionKey/);
  assert.match(wireLayerSource, /hoveredConnectionKey === connectionKey/);
  assert.match(wireLayerSource, /interactive=\{allowConnectionHover\}/);
  assert.match(wireLayerSource, /onHoverStart=\{\(event\) => onConnectionHoverStart\(connectionKey, event\)\}/);
  assert.match(wireLayerSource, /onHoverMove=\{\(event\) => onConnectionHoverMove\(connectionKey, event\)\}/);
  assert.match(wireSource, /from '\.\/nodeCanvas\/wireGeometry\.js';/);
  assert.match(wireSource, /const WireInteractionTarget/);
  assert.match(wireSource, /className="wire-hit-area"/);
  assert.match(wireSource, /d=\{getWirePath\(\{ sx, sy, ex, ey \}\)\}/);
});

test('wire bend handles are local rendered-wire affordances with persisted connection data', () => {
  const wireLayerSource = readFileSync(join(componentsDir, 'WireLayer.tsx'), 'utf8');
  const wireStyles = /const wiresStyles = css`(?<styles>[\s\S]*?)`;/u.exec(wireLayerSource)?.groups?.styles;
  const ghostWireStyles = /\.wire-bend-point-ghost\s*\{(?<styles>[\s\S]*?)\n\s*\}/u.exec(wireStyles ?? '')?.groups
    ?.styles;

  assert.ok(wireStyles, 'Expected WireLayer styles to stay local to wiresStyles');
  assert.ok(ghostWireStyles, 'Expected ghost bend point styles to stay local to wiresStyles');
  assert.match(wireStyles, /\.wire-bend-point/);
  assert.match(wireStyles, /\.wire-bend-point[\s\S]*pointer-events:\s*none;/);
  assert.match(wireStyles, /\.wire-bend-point\.editable[\s\S]*pointer-events:\s*all;/);
  assert.match(wireStyles, /\.wire-bend-point-ghost/);
  assert.match(ghostWireStyles, /pointer-events:\s*none;/);
  assert.match(ghostWireStyles, /stroke:\s*var\(--primary-dark\);/);
  assert.match(ghostWireStyles, /opacity:\s*0\.5;/);
  assert.doesNotMatch(ghostWireStyles, /stroke-dasharray/);
  assert.match(wireLayerSource, /useSetConnectionBendPointCommand\(\)/);
  assert.match(wireLayerSource, /from '\.\/nodeCanvas\/connectionBendInteraction\.js';/);
  assert.match(wireLayerSource, /const wireClickStartRef = useRef/);
  assert.match(wireLayerSource, /const \[hoveredConnectionPoint, setHoveredConnectionPoint\]/);
  assert.match(wireLayerSource, /const ghostBendPoint/);
  assert.match(wireLayerSource, /className="wire-bend-point wire-bend-point-ghost"/);
  assert.match(wireLayerSource, /onMouseDown=\{\(event\) => onConnectionMouseDown\(connectionKey, event\)\}/);
  assert.match(wireLayerSource, /shouldCommitConnectionBendClick/);
  assert.match(wireLayerSource, /editable: allowConnectionBendEditing/);
  assert.match(wireLayerSource, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*setConnectionBendPoint/s);
  assert.match(wireLayerSource, /onDoubleClick=\{\(event\) => onConnectionBendDoubleClick\(connection, event\)\}/);
  assert.match(wireLayerSource, /onMouseDown=\{\(event\) => onConnectionBendMouseDown\(connection, connectionKey, event\)\}/);
  assert.match(wireLayerSource, /bendPoint=\{bendPoint\}/);
});
