import { badRequest } from './utils/httpError.js';

export type ObjectStorageLocation = {
  objectStorageBucket: string;
  objectStorageEndpoint: string;
  objectStorageRegion: string;
  objectStoragePrefix: string;
  objectStorageForcePathStyle: boolean;
};

export function parseLegacyStorageUrl(rawUrl: string): ObjectStorageLocation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest('Object storage URL must be a valid URL');
  }
  const pathSegments = url.pathname.split('/').filter(Boolean);
  const hostParts = url.hostname.split('.').filter(Boolean);
  if (pathSegments.length > 0) {
    return {
      objectStorageBucket: pathSegments[0]!,
      objectStorageEndpoint: url.origin,
      objectStorageRegion: hostParts[0] === 's3' && hostParts[1] ? hostParts[1]! : 'us-east-1',
      objectStoragePrefix: 'workflows/',
      objectStorageForcePathStyle: true,
    };
  }
  if (pathSegments.length === 0 && hostParts.length >= 2) {
    const region =
      url.hostname.endsWith('.digitaloceanspaces.com') && hostParts.length >= 3
        ? hostParts[1]!
        : hostParts[1] === 's3'
          ? hostParts[2] || 'us-east-1'
          : 'us-east-1';
    return {
      objectStorageBucket: hostParts[0]!,
      objectStorageEndpoint: `${url.protocol}//${hostParts.slice(1).join('.')}`,
      objectStorageRegion: region,
      objectStoragePrefix: 'workflows/',
      objectStorageForcePathStyle: false,
    };
  }
  throw badRequest('Object storage URL must identify exactly one bucket');
}

export function validateObjectStorageLocation(location: ObjectStorageLocation): ObjectStorageLocation {
  const { objectStorageBucket: bucket, objectStorageEndpoint: endpoint, objectStorageRegion: region } = location;
  if (!bucket || /[\s/?#\\]/.test(bucket)) {
    throw badRequest('Object storage bucket must be a nonempty bucket name');
  }
  if (!region || /[\s/?#\\]/.test(region)) {
    throw badRequest('Object storage region must be a nonempty region identifier');
  }
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw badRequest('Object storage endpoint must be an HTTP(S) origin');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== endpoint ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw badRequest(
        'Object storage endpoint must be an HTTP(S) origin without a path, credentials, query, or fragment',
      );
    }
  }
  const prefix = location.objectStoragePrefix;
  if (
    !prefix ||
    prefix.startsWith('/') ||
    prefix.includes('\\') ||
    !prefix.endsWith('/') ||
    prefix.includes('//') ||
    prefix.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw badRequest('Object storage prefix must be a relative path ending in / without empty, . or .. segments');
  }
  if (prefix.startsWith('runtime-libraries/') || 'runtime-libraries/'.startsWith(prefix)) {
    throw badRequest('Workflow object storage prefix must not overlap the runtime-libraries/ prefix');
  }
  return location;
}

export function buildLegacyStorageUrl(location: ObjectStorageLocation): string {
  const endpoint = location.objectStorageEndpoint || `https://s3.${location.objectStorageRegion}.amazonaws.com`;
  if (location.objectStorageForcePathStyle) {
    return `${endpoint}/${encodeURIComponent(location.objectStorageBucket)}`;
  }
  const url = new URL(endpoint);
  return `${url.protocol}//${location.objectStorageBucket}.${url.host}`;
}
