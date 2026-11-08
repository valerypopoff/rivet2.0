import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** Package the actual entrypoint's dependency closure, without rollout tooling. */
export async function prepareAutoscalerRuntime(output) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['deploy/studio-server/scripts/lib/execution-autoscaler-entry.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    metafile: true,
    write: false,
  });
  for (const input of Object.keys(result.metafile.inputs))
    assert.match(
      input,
      /^deploy\/studio-server\/scripts\/lib\/(?:execution-autoscaler[^/]*|release-operation-(?:journal|state)|read-concurrently|kubernetes-response-error)\.mjs$/,
      'Autoscaler runtime must not import deployment or qualification implementations',
    );
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'execution-autoscaler-entry.mjs'), result.outputFiles[0].contents);
  return Object.keys(result.metafile.inputs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(process.argv[2], 'An output directory is required');
  await prepareAutoscalerRuntime(path.resolve(process.argv[2]));
}
