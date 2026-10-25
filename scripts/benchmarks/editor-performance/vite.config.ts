import base from '../../../packages/studio-server-web/vite.config';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const directory = process.env.RIVET_EDITOR_BENCH_OUTPUT;
if (!directory || !path.isAbsolute(directory)) throw new Error('Benchmark output must be an absolute path');
export default {
  ...base,
  envDir: directory,
  build: { ...base.build, outDir: path.join(directory, 'dist'), manifest: 'profile-manifest.json' },
  plugins: [
    ...base.plugins,
    {
      name: 'local-performance-attribution',
      generateBundle(_options, bundle) {
        this.emitFile({
          type: 'asset',
          fileName: 'benchmark-source.json',
          source: readFileSync(path.join(directory, 'source.json'), 'utf8'),
        });
        this.emitFile({
          type: 'asset',
          fileName: 'profile-attribution.json',
          source: JSON.stringify(
            Object.values(bundle)
              .filter((item) => item.type === 'chunk')
              .map((chunk) => ({
                fileName: chunk.fileName,
                imports: chunk.imports,
                dynamicImports: chunk.dynamicImports,
                isEntry: chunk.isEntry,
                modules: Object.entries(chunk.modules).map(([id, data]) => ({
                  id,
                  renderedLength: data.renderedLength,
                })),
              })),
            null,
            2,
          ),
        });
      },
    },
  ],
};
