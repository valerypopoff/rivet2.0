export function assertRecordingReaderInventory(manifest: any, resources: any[], release: string): void;
export function assertRecordingReleaseSettled(
  configmaps: any[],
  release: string,
  namespace: string,
  manifestDigest: string,
  now?: () => number,
): void;
