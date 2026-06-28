import type { DataValue, Outputs } from '@valerypopoff/rivet2-node';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type OutputShapeOptions = {
  includeCost?: boolean;
  outputKey?: string;
  unwrapOutput?: string;
};

export function shapeOutputs(
  outputs: Outputs,
  options: OutputShapeOptions,
): unknown {
  validateOutputShapeOptions(options);

  const { includeCost = false, outputKey, unwrapOutput } = options;

  const visibleOutputs: Record<string, DataValue | undefined> = { ...outputs };

  if (!includeCost) {
    delete visibleOutputs.cost;
  }

  const selectedOutputKey = unwrapOutput ?? outputKey;

  if (!selectedOutputKey) {
    return visibleOutputs;
  }

  if (!Object.prototype.hasOwnProperty.call(visibleOutputs, selectedOutputKey)) {
    throw new Error(`Output "${selectedOutputKey}" was not returned by the graph.`);
  }

  const selectedOutput = visibleOutputs[selectedOutputKey];
  return unwrapOutput ? selectedOutput?.value : selectedOutput;
}

export function validateOutputShapeOptions({ outputKey, unwrapOutput }: OutputShapeOptions): void {
  if (outputKey && unwrapOutput) {
    throw new Error('Use only one output selector. Received: --output-key, --unwrap-output.');
  }
}

export async function writeJsonOutput(payload: unknown, outputFile: string | undefined): Promise<void> {
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  if (outputFile) {
    await writeFile(resolve(process.cwd(), outputFile), json, 'utf8');
    return;
  }

  process.stdout.write(json);
}
