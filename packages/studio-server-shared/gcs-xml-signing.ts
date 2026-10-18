import { createHash, createHmac } from 'node:crypto';

type XmlRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string | string[] | null>;
};

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Node-only transport adapter for GCS XML generation preconditions. The AWS
 * SDK still owns serialization, payload hashing and HTTP. GCS rejects mixed
 * x-amz/x-goog dialects; its x-amz-if-generation-match lookalike is ignored.
 * Re-sign just guarded requests using Google's documented GOOG4 HMAC dialect. */
export function signGoogleXmlPrecondition(request: XmlRequest, secretAccessKey: string): void {
  if (request.headers['x-goog-if-generation-match'] === undefined) return;
  const authorization = request.headers.authorization;
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=[a-f0-9]{64}$/.exec(
      authorization ?? '',
    );
  if (!match || !secretAccessKey) throw Error('GCS conditional request signing identity is unavailable');
  const [, accessKeyId, date, region, previousSignedHeaders] = match;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'authorization') continue;
    const normalized = name.replace(/^x-amz-/, 'x-goog-');
    if (headers[normalized] !== undefined && headers[normalized] !== value)
      throw Error('Conflicting GCS request headers');
    headers[normalized] = value;
  }
  const signed = [
    ...new Set(previousSignedHeaders!.split(';').map((name) => name.replace(/^x-amz-/, 'x-goog-'))),
  ].sort();
  if (
    !signed.includes('x-goog-if-generation-match') ||
    !headers.host ||
    !/^\d{8}T\d{6}Z$/.test(headers['x-goog-date'] ?? '') ||
    !/^(UNSIGNED-PAYLOAD|[a-f0-9]{64})$/.test(headers['x-goog-content-sha256'] ?? '') ||
    signed.some((name) => typeof headers[name] !== 'string')
  )
    throw Error('GCS conditional request has incomplete signed headers');
  const canonicalHeaders = signed.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = Object.entries(request.query ?? {})
    .flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value ?? '']).map((item) => `${encode(name)}=${encode(item)}`),
    )
    .sort()
    .join('&');
  const scope = `${date}/${region}/storage/goog4_request`;
  const canonical = [
    request.method,
    request.path,
    query,
    canonicalHeaders,
    signed.join(';'),
    headers['x-goog-content-sha256'],
  ].join('\n');
  const stringToSign = [
    'GOOG4-HMAC-SHA256',
    headers['x-goog-date'],
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  let key = Buffer.from(`GOOG4${secretAccessKey}`);
  for (const part of [date!, region!, 'storage', 'goog4_request'])
    key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.authorization = `GOOG4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  request.headers = headers;
}
