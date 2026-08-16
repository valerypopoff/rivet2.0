import anthropicPlugin from './plugins/anthropic/index.js';
import autoevalsPlugin from './plugins/autoevals/index.js';
import assemblyAiPlugin from './plugins/assemblyAi/index.js';
import { huggingFacePlugin } from './plugins/huggingface/plugin.js';
import pineconePlugin from './plugins/pinecone/index.js';
import gentracePlugin from './plugins/gentrace/index.js';
export { exportGentraceEvaluationRun, getGentracePipelines } from './plugins/gentrace/plugin.js';
import { openAIPlugin } from './plugins/openai/plugin.js';
import { googlePlugin } from './plugins/google/plugin.js';
import type { RivetPlugin } from './model/RivetPlugin.js';

export {
  anthropicPlugin,
  autoevalsPlugin,
  assemblyAiPlugin,
  pineconePlugin,
  huggingFacePlugin,
  gentracePlugin,
  googlePlugin,
};

export const plugins = {
  anthropic: anthropicPlugin,
  autoevals: autoevalsPlugin,
  assemblyAi: assemblyAiPlugin,
  pinecone: pineconePlugin,
  huggingFace: huggingFacePlugin,
  gentrace: gentracePlugin,
  openai: openAIPlugin,
  google: googlePlugin,
};

/** Resolve a built-in plugin spec by id. Throws for unknown ids. */
export function resolveBuiltInPlugin(id: string): RivetPlugin {
  const plugin = plugins[id as keyof typeof plugins];
  if (!plugin) {
    throw new Error(`Unknown built-in plugin: ${id}`);
  }
  return plugin;
}
