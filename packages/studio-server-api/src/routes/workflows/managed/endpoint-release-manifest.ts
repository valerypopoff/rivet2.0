import { z } from 'zod';

export const MAX_ARTIFACTS = 128;
export const MAX_BINDINGS = 12_000;
export const MAX_ENDPOINT_RELEASE_BYTES = 64 * 1024 * 1024;
export const ENDPOINT_RELEASE_IO_TIMEOUT_MS = 30_000;
const projectSchema = z.object({
  artifactId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string(),
  relativePath: z.string().min(1),
  bundleRelativePath: z.string().min(1).optional(),
  savedAt: z.string(),
});
const selectorSchema = z.enum(['latest', 'published', 'project-reference']);
const manifestSchema = z.object({
  version: z.literal(1),
  rootArtifactId: z.string().min(1),
  entryGraphId: z.string().min(1),
  projects: z.array(projectSchema).min(1).max(MAX_ARTIFACTS),
  references: z
    .array(
      z.object({
        sourceArtifactId: z.string().min(1),
        sourceGraphId: z.string(),
        nodeId: z.string(),
        targetArtifactId: z.string().min(1),
        targetGraphId: z.string(),
        selector: selectorSchema,
      }),
    )
    .max(MAX_BINDINGS),
});
export type EndpointReleaseManifest = z.infer<typeof manifestSchema>;
export type EndpointReleaseReference = EndpointReleaseManifest['references'][number];
export type EndpointReleaseSelector = z.infer<typeof selectorSchema>;

export function parseEndpointReleaseManifest(value: unknown, owner: string, rootRevisionId: string) {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success || parsed.data.rootArtifactId !== rootRevisionId) return null;
  const manifest = parsed.data;
  const projects = new Map(manifest.projects.map((project) => [project.artifactId, project]));
  if (projects.size !== manifest.projects.length || projects.get(rootRevisionId)?.projectId !== owner) return null;
  return { manifest, projects };
}

export function endpointReleaseTargetKey(projectId: string, selector: EndpointReleaseSelector) {
  return JSON.stringify([projectId, selector]);
}

export type EndpointReleaseTarget = {
  artifactId: string;
  callerProjectIds: Set<string>;
  selector: EndpointReleaseSelector;
};

export function indexEndpointReleaseTargets({ manifest, projects }: NonNullable<ReturnType<typeof parseEndpointReleaseManifest>>) {
  const targets = new Map<string, EndpointReleaseTarget>();
  for (const edge of manifest.references) {
    const source = projects.get(edge.sourceArtifactId);
    const target = projects.get(edge.targetArtifactId);
    if (!source || !target) return { error: 'A captured dependency is unavailable.' } as const;

    const key = endpointReleaseTargetKey(target.projectId, edge.selector);
    const binding = targets.get(key);
    if (binding) {
      if (binding.artifactId !== target.artifactId) return { error: 'The captured dependency has conflicting revisions.' } as const;
      binding.callerProjectIds.add(source.projectId);
    } else {
      targets.set(key, {
        artifactId: target.artifactId,
        callerProjectIds: new Set([source.projectId]),
        selector: edge.selector,
      });
    }
  }
  return { targets };
}
