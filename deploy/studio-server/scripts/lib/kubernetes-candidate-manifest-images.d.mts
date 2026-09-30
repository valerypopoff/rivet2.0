export function assertCandidateManifestImages(
  manifest: string,
  images: Record<string, { repository: string; digest: string }>,
  runnerName: string,
): void;
