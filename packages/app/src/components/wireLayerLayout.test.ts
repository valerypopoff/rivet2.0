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
  assert.match(wireLayerSource, /onHoverStart=\{\(\) => onConnectionHoverStart\(connectionKey\)\}/);
  assert.match(wireSource, /const WireInteractionTarget/);
  assert.match(wireSource, /className="wire-hit-area"/);
  assert.match(wireSource, /d=\{getWirePath\(\{ sx, sy, ex, ey \}\)\}/);
  assert.match(wireSource, /function getWirePath/);
});
