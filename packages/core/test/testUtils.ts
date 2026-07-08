import { readFile } from 'node:fs/promises';
import {
  deserializeProject,
  globalRivetNodeRegistry,
  GraphProcessor,
  type ProcessContext,
  type Project,
} from '../src/index.js';
import { GptTokenizerTokenizer } from '../src/integrations/GptTokenizerTokenizer.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

export async function loadTestGraphs(): Promise<Project> {
  return loadProjectFromFile(join(testDir, './test-graphs.rivet-project'));
}

export async function loadTestGraphInProcessor(graphName: string) {
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
