import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const appSource = join(repoRoot, 'packages', 'app', 'src');
const files = [
  join(appSource, 'components', 'CodeEditor.tsx'),
  ...readdirSync(join(appSource, 'utils', 'monaco'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(appSource, 'utils', 'monaco', entry.name)),
];
const forbiddenImport = /from\s+['"][^'"]*(?:\/state\/|\/components\/|\/hooks\/|\/editors\/)[^'"]*['"]/;
const failures = [];

for (const file of files) {
  if (forbiddenImport.test(readFileSync(file, 'utf8'))) {
    failures.push(file.slice(repoRoot.length + 1).replaceAll('\\', '/'));
  }
}

if (failures.length > 0) {
  console.error('Low-level Monaco owners must not import app state, hooks, components, or node editors:');
  for (const file of failures) console.error(`- ${file}`);
  process.exitCode = 1;
} else {
  console.log('Low-level Monaco/editor capability boundaries are clean.');
}
