import generatedBuiltInHelp from '../graphs/graph-builder-node-help.generated.json';
import graphBuilderPolicyManifest from '../graphs/graph-builder-policy.manifest.json';

export { generatedBuiltInHelp, graphBuilderPolicyManifest };

/**
 * Keeps the policy project in its own lazy browser chunk while centralizing
 * access to checked Graph Builder assets at the app source boundary.
 */
export async function loadGraphBuilderPolicyProjectAsset(): Promise<string> {
  const asset = await import('../graphs/graph-builder-policy.rivet-project?raw');
  return asset.default;
}
