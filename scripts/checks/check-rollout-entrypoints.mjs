import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

// The production entry point is not exercised by the staging actor. Check its
// lexical bindings before publishing rather than discovering missing imports in prod.
export function rolloutEntryPointMessages(source, file = 'entrypoint.mjs') {
  return new Linter().verify(
    source,
    [
      {
        files: ['**/*.mjs'],
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          globals: {
            process: 'readonly',
            console: 'readonly',
            Buffer: 'readonly',
            URL: 'readonly',
            fetch: 'readonly',
            AbortSignal: 'readonly',
            AbortController: 'readonly',
            setTimeout: 'readonly',
            clearTimeout: 'readonly',
            structuredClone: 'readonly',
          },
        },
        rules: { 'no-undef': 'error' },
      },
    ],
    { filename: file },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let errors = 0;
  for (const name of ['deploy-kubernetes-release', 'deploy-qualified-production', 'prepare-qualified-deployment']) {
    const file = `deploy/studio-server/scripts/${name}.mjs`;
    const messages = rolloutEntryPointMessages(fs.readFileSync(file, 'utf8'), file);
    errors += messages.length;
    for (const message of messages) console.error(`${file}:${message.line}:${message.column}: ${message.message}`);
  }
  if (errors) process.exitCode = 1;
  else console.log('Production rollout entry-point bindings are valid.');
}
