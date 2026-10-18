import { S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { signGoogleXmlPrecondition } from '../../studio-server-shared/gcs-xml-signing.ts';
import { hash, validId, maxFileBytes } from './assets.mjs';

export function createAssetStore(env = process.env) {
  const installation = env.RIVET_WEB_ASSETS_INSTALLATION;
  if (!installation) return undefined; // Non-HA static serving keeps its original credential footprint.
  const bucket = env.RIVET_DEPLOYMENT_STORAGE_BUCKET, region = env.RIVET_DEPLOYMENT_STORAGE_REGION;
  const endpoint = env.RIVET_DEPLOYMENT_STORAGE_ENDPOINT || undefined;
  const accessKeyId = env.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY_ID, secretAccessKey = env.RIVET_DEPLOYMENT_STORAGE_ACCESS_KEY;
  if (!bucket || !region || (!!accessKeyId !== !!secretAccessKey)) throw Error('Frontend object-storage configuration is incomplete');
  const prefix = env.RIVET_DEPLOYMENT_STORAGE_PREFIX || 'workflows/';
  if (prefix.startsWith('/') || prefix.includes('\\') || !prefix.endsWith('/') ||
      prefix.slice(0, -1).split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid frontend storage prefix');
  const google = !!endpoint && /(^|\.)storage\.googleapis\.com$/.test(new URL(endpoint).hostname);
  if (google && !secretAccessKey) throw Error('GCS frontend publication requires explicit HMAC credentials');
  const client = new S3Client({ region, endpoint, forcePathStyle: env.RIVET_DEPLOYMENT_STORAGE_FORCE_PATH_STYLE === 'true',
    ...(accessKeyId ? { credentials: { accessKeyId, secretAccessKey } } : {}), maxAttempts: 1,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 } });
  if (google) {
    const handler = client.config.requestHandler;
    client.config.requestHandler = {
      handle(request, options) { signGoogleXmlPrecondition(request, secretAccessKey); return handler.handle(request, options); },
      destroy() { handler.destroy(); },
    };
  }
  return new S3Assets(client, { bucket, prefix: `${prefix}web-assets/${hash(installation)}/`,
    google });
}

/** Content-addressed, create-only compressed objects. No object ever carries
 * Content-Encoding (GCS must not transcode stored bytes), and no delete exists. */
export class S3Assets {
  constructor(client, config) { this.client = client; this.config = config; }
  command(Type, id, extra = {}) {
    if (!validId(id)) throw Error('Invalid frontend object identity');
    const command = new Type({ Bucket: this.config.bucket, Key: `${this.config.prefix}${id}.gz`, ...extra });
    if (Type === PutObjectCommand && this.config.google) command.middlewareStack.add(next => args => {
      args.request.headers['x-goog-if-generation-match'] = '0';
      return next(args);
    }, { step: 'build', name: 'rivetFrontendCreateOnly' });
    return command;
  }
  async head(id, bytes) {
    try {
      const value = await this.client.send(this.command(HeadObjectCommand, id));
      this.validate(value, id, bytes);
      return true;
    } catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
  }
  validate(value, id, bytes) {
    if (value.Metadata?.sha256 !== id || value.Metadata?.bytes !== String(bytes) || value.ContentEncoding ||
        !Number.isSafeInteger(value.ContentLength) || value.ContentLength < 1 || value.ContentLength > Math.min(maxFileBytes + 65536, bytes + 65536))
      throw Error('Frontend object identity is unconfirmed');
  }
  async put(id, body, bytes) {
    if (await this.head(id, bytes)) return;
    try {
      await this.client.send(this.command(PutObjectCommand, id, { Body: body, ContentLength: body.length,
        ContentType: 'application/octet-stream', Metadata: { sha256: id, bytes: String(bytes) }, IfNoneMatch: '*' }));
    } catch (error) {
      // Another publisher, or a lost acknowledgement: observe the immutable
      // object instead of replaying an uncertain write or overwriting it.
      if (!(await this.head(id, bytes))) throw error;
    }
  }
  async get(id, bytes) {
    let value;
    try { value = await this.client.send(this.command(GetObjectCommand, id)); }
    catch (error) { if (error.$metadata?.httpStatusCode === 404) return undefined; throw error; }
    try {
      const expected = typeof bytes === 'object' ? Number(value.Metadata?.bytes) : bytes;
      this.validate(value, id, expected);
      if (!Number.isSafeInteger(expected) || expected < 0 || expected > (bytes.maxBytes ?? bytes) || !(value.Body instanceof Readable))
        throw Error('Frontend object body exceeds its bound');
      return { stream: value.Body, length: value.ContentLength, bytes: async () => {
        const chunks = []; let size = 0;
        try {
          for await (const chunk of value.Body) {
            size += chunk.length;
            if (size > value.ContentLength) throw Error('Frontend object exceeds its bound');
            chunks.push(chunk);
          }
          return Buffer.concat(chunks, size);
        } finally { value.Body.destroy(); }
      } };
    } catch (error) { value.Body?.destroy(); throw error; }
  }
  dispose() { this.client.destroy(); }
}
