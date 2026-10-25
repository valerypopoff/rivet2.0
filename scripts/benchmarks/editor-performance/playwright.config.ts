import base from '../../../packages/studio-server-web/playwright.observe.config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const output = process.env.RIVET_EDITOR_BENCH_OUTPUT!;
export default {
  ...base,
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: 'benchmark.spec.ts',
  workers: 1,
  timeout: 600000,
  outputDir: path.join(output, 'browser'),
  reporter: [['list']],
  use: { ...base.use, trace: 'off', video: 'off', actionTimeout: 20000, navigationTimeout: 30000 },
};
