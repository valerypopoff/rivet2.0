import { loadDevEnv } from './lib/dev-env.mjs';
import { prepareRivetDockerContext } from './lib/rivet-source-context.mjs';

const rootDir = process.cwd();
const { mergedEnv } = loadDevEnv(rootDir);

prepareRivetDockerContext(rootDir, mergedEnv);
