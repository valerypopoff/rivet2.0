import { readFile } from 'node:fs/promises';
import { deserializeProject } from '../src/utils/serialization/serialization.js';
import type { ProcessContext } from '../src/model/ProcessContext.js';
import type { Project } from '../src/model/Project.js';
import { GptTokenizerTokenizer } from '../src/integrations/GptTokenizerTokenizer.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

export async function loadTestGraphs(): Promise<Project> {
  return loadProjectFromFile(join(testDir, './test-graphs.rivet-project'));
}

export async function loadTestGraphInProcessor(graphName: string) {
  // Serialization and isolated node tests must not boot every SDK/plugin merely
  // to obtain fixture text or a process context. Registry tests still exercise
  // the complete public registry when they actually construct a processor.
  const { GraphProcessor, globalRivetNodeRegistry } = await import('../src/index.js');
  const project = await loadTestGraphs();
  const graph = Object.values(project.graphs).find((g) => g.metadata!.name === graphName);

  if (!graph) {
    throw new Error(`Could not find graph with name ${graphName}`);
  }

  return new GraphProcessor(project, graph.metadata!.id!, globalRivetNodeRegistry);
}

export async function loadProjectFromFile(path: string): Promise<Project> {
  const content = await readFile(path, { encoding: 'utf8' });
  return loadProjectFromString(content, path);
}

export function loadProjectFromString(content: string, path: string | null = null): Project {
  const [project] = deserializeProject(content, path);
  return project;
}

export function testProcessContext(): ProcessContext {
  return {
    tokenizer: new GptTokenizerTokenizer(),
    settings: {
      openAiKey: process.env.OPENAI_API_KEY,
      openAiOrganization: process.env.OPENAI_ORG_ID,
      openAiEndpoint: '',
    },
  };
}
