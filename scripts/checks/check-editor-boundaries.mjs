import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const forbiddenEditorImport = /from\s+['"][^'"]*(?:\/state\/|\/components\/|\/hooks\/|\/editors\/)[^'"]*['"]/;
const forbiddenExecutionImport =
  /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](?:react(?:-dom)?(?=['"/])|jotai(?=['"/])|[^'"]*(?:\/(?:state|hooks|providers|components|editors)\/))/;

export function hasForbiddenExecutionImport(source) {
  return forbiddenExecutionImport.test(source);
}

/** Ingress and presentation adapters may read history, but only the shared writer commits it. */
export function hasDirectExecutionStateWrite(source) {
  return /(?:\bstore\.set|\buseSetAtom)\s*\(\s*(?:projectExecutionSnapshotsState|executionSnapshotsState|lastRunDataByNodeState|graphRunHistoryByViewState|selectedProcessPageNodesState|selectedGraphRunByViewState|selectedLLMChatOutputPageByInvocationState|runActivityJournalState)\b/.test(
    source,
  );
}

export function checkEditorBoundaries(repoRoot = defaultRoot) {
  const appSource = join(repoRoot, 'packages', 'app', 'src');
  const monaco = join(appSource, 'utils', 'monaco');
  const editorFiles = [
    join(appSource, 'components', 'CodeEditor.tsx'),
    ...readdirSync(monaco, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name))
      .map((entry) => join(monaco, entry.name)),
  ];
  const execution = join(appSource, 'domain', 'execution');
  const ingressFiles = [
    'hooks/useLocalExecutor.ts',
    'hooks/useRemoteExecutor.ts',
    'providers/ExecutorSessionContext.tsx',
    'hooks/useGraphExecutionEvents.ts',
    'hooks/useNodeExecutionEvents.ts',
    'hooks/useExecutionDataFlow.ts',
    'hooks/useRunActivityExecutionEvents.ts',
  ].map((file) => join(appSource, file));
  const executionFiles = readdirSync(execution, { recursive: true })
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|spec)\./.test(file))
    .map((file) => join(execution, file));
  return [
    ...editorFiles.filter((file) => forbiddenEditorImport.test(readFileSync(file, 'utf8'))),
    ...executionFiles.filter((file) => hasForbiddenExecutionImport(readFileSync(file, 'utf8'))),
    ...ingressFiles.filter((file) => hasDirectExecutionStateWrite(readFileSync(file, 'utf8'))),
  ].map((file) =>
    file
      .slice(repoRoot.length)
      .replace(/^[\\/]/, '')
      .replaceAll('\\', '/'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkEditorBoundaries();
  if (failures.length) {
    console.error('Editor/execution boundary violations (forbidden imports or direct ingress history writes):');
    for (const file of failures) console.error(`- ${file}`);
    process.exitCode = 1;
  } else {
    console.log('Low-level editor and execution coordination boundaries are clean.');
  }
}
