import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));
const appSrcDir = dirname(componentsDir);

test('frozen node output visuals stay compact and canvas-scoped', () => {
  const normalVisualNodeContentSource = readFileSync(
    join(componentsDir, 'visualNode', 'NormalVisualNodeContent.tsx'),
    'utf8',
  );
  const visualNodeSource = readFileSync(join(componentsDir, 'VisualNode.tsx'), 'utf8');
  const zoomedOutVisualNodeContentSource = readFileSync(
    join(componentsDir, 'visualNode', 'ZoomedOutVisualNodeContent.tsx'),
    'utf8',
  );
  const nodeFullscreenOutputSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeFullscreenOutput.tsx'),
    'utf8',
  );
  const nodeInlineOutputSource = readFileSync(join(componentsDir, 'nodeOutput', 'NodeInlineOutput.tsx'), 'utf8');
  const contextMenuSource = readFileSync(join(componentsDir, 'ContextMenu.tsx'), 'utf8');
  const nodeStylesSource = readFileSync(join(componentsDir, 'nodeStyles.ts'), 'utf8');
  const contextMenuConfigurationSource = readFileSync(
    join(appSrcDir, 'hooks', 'useContextMenuConfiguration.ts'),
    'utf8',
  );
  const snowflakeIconSource = readFileSync(join(appSrcDir, 'assets', 'icons', 'snowflake-icon.svg'), 'utf8');

  assert.equal([...snowflakeIconSource.matchAll(/<path\b/g)].length, 3);
  assert.match(contextMenuConfigurationSource, /label: 'Freeze node output'/);
  assert.match(contextMenuConfigurationSource, /label: 'Freeze node outputs'/);
  assert.match(contextMenuConfigurationSource, /disabled: isFreezeDisabled/);
  assert.match(contextMenuConfigurationSource, /disabledReason: getFreezeDisabledReason/);
  assert.doesNotMatch(contextMenuSource, /padding-top: 0\.65em;/);
  assert.doesNotMatch(contextMenuSource, /padding-bottom: 0\.65em;/);
  assert.match(contextMenuSource, /padding-block: calc\(\(2\.8em - 1\.2em\) \/ 2\);/);
  assert.match(contextMenuSource, /className=\{clsx\('label-area', \{ 'has-sublabel': subLabel \}\)\}/);
  assert.match(contextMenuSource, /margin-top: 0\.55em;/);
  assert.match(contextMenuConfigurationSource, /label: 'Unfreeze node output'/);
  assert.match(contextMenuConfigurationSource, /label: 'Unfreeze node outputs'/);
  assert.doesNotMatch(normalVisualNodeContentSource, /frozen-node-indicator/);
  assert.doesNotMatch(zoomedOutVisualNodeContentSource, /frozen-node-indicator/);
  assert.match(visualNodeSource, /useExecutorSessionState/);
  assert.match(visualNodeSource, /executorSession\.target\?\.type !== 'external-debugger'/);
  assert.match(normalVisualNodeContentSource, /isFrozen=\{isFrozen\}/);
  assert.match(
    nodeInlineOutputSource,
    /import SnowflakeIcon from '..\/..\/assets\/icons\/snowflake-icon\.svg\?react';/,
  );
  assert.match(nodeInlineOutputSource, /<div className="frozen-output-notice" aria-label="Output is frozen">/);
  assert.match(nodeInlineOutputSource, /<span>Output is frozen<\/span>/);
  const colorsSource = readFileSync(join(appSrcDir, 'colors.css'), 'utf8');

  assert.match(colorsSource, /--node-frozen-output-accent: #68b7ff;/);
  assert.match(
    colorsSource,
    /--node-frozen-output-bg: color-mix\(in srgb, var\(--node-frozen-output-accent\) 25%, var\(--grey-darkest\) 83%\);/,
  );
  assert.doesNotMatch(nodeStylesSource, /--node-frozen-output-pattern/);
  assert.doesNotMatch(nodeStylesSource, /data:image\/svg\+xml/);
  assert.doesNotMatch(nodeStylesSource, /background-image: var\(--node-frozen-output-pattern\);/);
  assert.doesNotMatch(nodeStylesSource, /\.node\.frozen:not\(\.isComment\) \.title-controls \{/);
  assert.doesNotMatch(nodeStylesSource, /frozen-node-indicator/);
  assert.doesNotMatch(nodeStylesSource, /\.node\.frozen:not\(\.isComment\) \.node-title \{/);
  assert.doesNotMatch(nodeStylesSource, /node-frozen-header-foreground/);
  assert.doesNotMatch(
    nodeStylesSource,
    /\.node\.frozen\.hasCustomBorderColor:not\(\.isComment\):not\(\.selected\):not\(\.hovered\):not\(\.overlayNode\)/,
  );
  assert.match(
    nodeStylesSource,
    /\.node\.frozen\.success:not\(\.running\) \.node-output:not\(\.multi\) \.node-output-inner,/,
  );
  assert.match(nodeStylesSource, /\.frozen-output-notice \{/);
  assert.match(nodeStylesSource, /color: var\(--node-frozen-output-accent\);/);
  assert.match(nodeStylesSource, /letter-spacing: 0\.08em;/);
  assert.match(nodeStylesSource, /transform: translateY\(-1px\);/);
  assert.match(
    nodeStylesSource,
    /\.node\.frozen\.success:not\(\.running\) \.node-output:not\(\.multi\) \.node-output-inner::after,/,
  );
  assert.match(nodeStylesSource, /height: 120px;/);
  assert.match(
    nodeStylesSource,
    /linear-gradient\(to bottom, rgba\(109, 213, 255, 0\.1\) 0%, rgba\(109, 213, 255, 0\) 100%\)/,
  );
  assert.match(nodeStylesSource, /mask-image: linear-gradient\(-60deg, transparent 0 38%, #000 38%\);/);
  assert.match(nodeStylesSource, /\.node\.frozen\.success:not\(\.running\) \.node-output:before \{/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /frozenNodeOutputsState/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /\[data-testid='fullscreen-output-modal--scrollable'\] \{/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /fullscreen-output-body[\s\S]*hasFrozenOutput \? ' frozen-output'/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /contentClassName=/);
  assert.doesNotMatch(nodeFullscreenOutputSource, /frozenFullscreenOutputModalCss/);
});
