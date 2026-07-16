import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const approvedHtmlSinkFiles = new Set([
  'packages/app/src/components/ColorizedPreformattedText.tsx',
  'packages/app/src/components/ContextMenu.tsx',
  'packages/app/src/components/NodeBody.tsx',
  'packages/app/src/components/NodeChangesModal.tsx',
  'packages/app/src/components/UserInputModal.tsx',
  'packages/app/src/components/editors/custom/AiAssistEditorBase.tsx',
  'packages/app/src/components/nodes/CommentNode.tsx',
  'packages/app/src/components/pluginsOverlay/PluginCatalogItem.tsx',
  'packages/app/src/components/renderDataValue/createScalarRenderers.tsx',
  'packages/app/src/components/rivetWebApps/RivetWebAppRenderer.tsx',
  'packages/app/src/components/trivet/NoTestCasesSplash.tsx',
  'packages/app/src/components/trivet/NoTestSuitesSplash.tsx',
  'packages/node/src/webAppClient.ts',
  'packages/node/src/webAppClientRenderer.ts',
]);

const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .map((file) => file.replaceAll('\\', '/'))
  .filter(
    (file) =>
      existsSync(join(repoRoot, file)) &&
      /^(?:packages\/app|packages\/node)\/src\/.*\.(?:ts|tsx)$/.test(file) &&
      !file.includes('/generated/') &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file),
  );

const violations = [];
for (const file of sourceFiles) {
  const source = readFileSync(join(repoRoot, file), 'utf8');
  if (/dangerouslySetInnerHTML|\.innerHTML\s*=/.test(source) && !approvedHtmlSinkFiles.has(file)) {
    violations.push(`${file}: unapproved raw HTML sink`);
  }
  if (/\bmarked\s*\(/.test(source) && file !== 'packages/app/src/hooks/useMarkdown.ts') {
    violations.push(`${file}: direct marked(...) call outside the Markdown renderer`);
  }
}

if (violations.length > 0) {
  console.error('Rich-text boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Rich-text sinks are confined to approved renderer owners.');
}
