import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsDir = dirname(fileURLToPath(import.meta.url));

test('fullscreen node output modal is rendered outside the canvas tree', () => {
  const nodeOutputSource = readFileSync(join(componentsDir, 'NodeOutput.tsx'), 'utf8');
  const nodeFullscreenOutputSource = readFileSync(
    join(componentsDir, 'nodeOutput', 'NodeFullscreenOutput.tsx'),
    'utf8',
  );
  const rivetAppSource = readFileSync(join(componentsDir, 'RivetApp.tsx'), 'utf8');
  const fullScreenModalSource = readFileSync(join(componentsDir, 'FullScreenModal.tsx'), 'utf8');

  assert.match(
    nodeOutputSource,
    /export \{ FullscreenNodeOutputModalRenderer \} from '\.\/nodeOutput\/NodeFullscreenOutput\.js';/,
  );
  assert.match(nodeFullscreenOutputSource, /export const FullscreenNodeOutputModalRenderer/);
  assert.doesNotMatch(nodeOutputSource, /const \[isModalOpen,\s*setIsModalOpen\] = useState/);
  const rendererMatch =
    /export const FullscreenNodeOutputModalRenderer: FC = \(\) => \{([\s\S]*?)\r?\n\};\r?\n\r?\nconst ResizableNodeFullscreenOutputModal/.exec(
      nodeFullscreenOutputSource,
    );
  assert.ok(rendererMatch);
  const rendererBody = rendererMatch[1] ?? '';
  assert.match(rendererBody, /useDependsOnPlugins\(\);/);
  assert.match(rendererBody, /graphMetadataState/);
  assert.match(rendererBody, /previousGraphIdRef\.current = graphId;/);
  assert.match(rendererBody, /previousGraphIdRef\.current !== graphId/);
  assert.match(rendererBody, /return \(\) => \{\s*setFullscreenOutputNodeId\(null\);\s*\};/);
  const normalizedRivetAppSource = rivetAppSource.replace(/\r\n/g, '\n');
  const graphBuilderIndex = normalizedRivetAppSource.indexOf('<GraphBuilder runGraph={tryRunGraph} />');
  const fullscreenModalIndex = normalizedRivetAppSource.indexOf('<AppErrorBoundary context="Fullscreen Output Modal"');
  const helpModalIndex = normalizedRivetAppSource.indexOf('<HelpModal />');

  assert.notEqual(graphBuilderIndex, -1);
  assert.notEqual(fullscreenModalIndex, -1);
  assert.notEqual(helpModalIndex, -1);
  assert.ok(fullscreenModalIndex > graphBuilderIndex);
  assert.ok(fullscreenModalIndex < helpModalIndex);
  assert.match(normalizedRivetAppSource, /\n      \)}\n      <AppErrorBoundary context="Fullscreen Output Modal"/);
  assert.match(fullScreenModalSource, /shouldReturnFocus={false}/);
});
