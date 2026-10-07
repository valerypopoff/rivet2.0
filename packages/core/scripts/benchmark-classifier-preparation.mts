import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Opt-in, synthetic, mocked HTTP benchmark. Never reads credentials or calls a provider.
const option = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const source = path.resolve(option('source', 'src'));
const runs = Number(option('runs', '30'));
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer.');
const runtime = source.endsWith('.mjs')
  ? await import(pathToFileURL(source).href)
  : {
      ...(await import(pathToFileURL(path.join(source, 'model/nodes/ClassifierEvaluateNode.ts')).href)),
      ...(await import(pathToFileURL(path.join(source, 'model/classifier/providers.ts')).href)),
    };
const { ClassifierEvaluateNodeImpl, getClassifierProvider } = runtime;
const originalFetch = globalThis.fetch;
const rows: Record<string, unknown>[] = [];
try {
  for (const provider of ['jev', 'liquid', 'openai']) {
    for (const characters of [64, 512 * 1024]) {
      for (const diagnostic of [false, true]) {
        const descriptor = getClassifierProvider(provider);
        const node = ClassifierEvaluateNodeImpl.create();
        const instance = new ClassifierEvaluateNodeImpl({
          ...node,
          data: { ...node.data, provider, outputRequestBody: diagnostic },
        });
        const state = { content: 'é"'.repeat(characters / 2), nested: [false, null, { label: 'synthetic' }] };
        const context = {
          executor: 'nodejs',
          signal: new AbortController().signal,
          settings: { classifierProviders: { [provider]: { apiKey: 'benchmark-only' } } },
        };
        globalThis.fetch = async () =>
          Response.json({
            model: descriptor.defaultModel,
            answers:
              provider === 'openai'
                ? [{ name: 'q', type: 'predicate', probability: 0.8 }]
                : { q: { type: 'noul', noul: 0.8 } },
            usage: { input_tokens: 1, output_tokens: 0 },
          });
        const execute = () =>
          instance.process(
            {
              state: { type: 'object', value: state },
              question1: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Check evidence' } },
            },
            context,
          );
        for (let warmup = 0; warmup < 5; warmup++) await execute();
        const durations: number[] = [];
        let maxHeapGrowth = 0,
          peakRss = 0;
        for (let run = 0; run < runs; run++) {
          globalThis.gc?.();
          const before = process.memoryUsage().heapUsed;
          const start = performance.now();
          await execute();
          durations.push(performance.now() - start);
          const memory = process.memoryUsage();
          maxHeapGrowth = Math.max(maxHeapGrowth, memory.heapUsed - before);
          peakRss = Math.max(peakRss, memory.rss);
        }
        durations.sort((left, right) => left - right);
        rows.push({
          provider,
          characters,
          diagnostic,
          runs,
          p50Ms: durations[Math.floor(runs * 0.5)],
          p95Ms: durations[Math.min(runs - 1, Math.floor(runs * 0.95))],
          maxObservedHeapGrowthMiB: maxHeapGrowth / 1048576,
          peakSampledRssMiB: peakRss / 1048576,
        });
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ source, node: process.version, rows }, null, 2));
