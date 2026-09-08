const { resolve } = require('node:path');

const workspaceSourceEntries = new Map([
  ['@valerypopoff/rivet2-core', '../../core/src/index.ts'],
  ['@valerypopoff/rivet2-core/interpolation-runtime', '../../core/src/interpolationRuntime.ts'],
  ['@valerypopoff/rivet2-core/interpolation-syntax', '../../core/src/utils/interpolationSyntax.ts'],
  ['@valerypopoff/rivet2-core/web-app-runtime', '../../core/src/webAppRuntime.ts'],
  ['@valerypopoff/rivet2-node', '../../node/src/index.ts'],
]);

function createRivetWorkspaceSourceResolver() {
  return {
    name: 'resolve-rivet-workspace-source',
    setup(build) {
      build.onResolve({ filter: /^@valerypopoff\/rivet2-(?:core|node)(?:\/.*)?$/ }, (args) => {
        const sourceEntry = workspaceSourceEntries.get(args.path);
        if (!sourceEntry) {
          throw new Error(`Executor bundling does not define a source entry for ${args.path}.`);
        }
        return { path: resolve(__dirname, sourceEntry) };
      });
    },
  };
}

module.exports = { createRivetWorkspaceSourceResolver };
