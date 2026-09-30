import { CreateBucketCommand, type BucketLocationConstraint } from '@aws-sdk/client-s3';

type BucketLocation = {
  objectStorageBucket: string;
  objectStorageRegion: string;
  objectStorageEndpoint: string | null;
};

/** AWS requires a location constraint outside us-east-1; custom S3 providers may not accept one. */
export function createManagedBucketCommand(location: BucketLocation): CreateBucketCommand {
  const endpointHost = location.objectStorageEndpoint
    ? new URL(location.objectStorageEndpoint).hostname.toLowerCase()
    : null;
  const isAws =
    endpointHost === null ||
    endpointHost === 'amazonaws.com' ||
    endpointHost.endsWith('.amazonaws.com') ||
    endpointHost.endsWith('.amazonaws.com.cn');
  return new CreateBucketCommand({
    Bucket: location.objectStorageBucket,
    ...(isAws && location.objectStorageRegion !== 'us-east-1'
      ? {
          CreateBucketConfiguration: {
            LocationConstraint: location.objectStorageRegion as BucketLocationConstraint,
          },
        }
      : {}),
  });
}
