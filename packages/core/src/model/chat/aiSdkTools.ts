import type { Tool } from 'ai';
import { jsonSchema } from 'ai';
import type { GptFunction } from '../DataValue.js';
import { createRivetToolRegistry } from '../chat-v2/rivetToolRegistry.js';

export function rivetToolsToAiSdk(functions: GptFunction[]): Record<string, Tool<any, never>> {
  return Object.fromEntries(
    [...createRivetToolRegistry(functions).byName.entries()].map(([name, fn]) => [
      name,
      {
        description: fn.description,
        inputSchema: jsonSchema(fn.parameters),
      } satisfies Tool<any, never>,
    ]),
  );
}
