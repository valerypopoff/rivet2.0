import { request } from 'node:http';
import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
import { sharedBundleArchives } from './ha-bundle-archives.js';
import { retainRequestWork } from './request-work.js';
import { ownsMaintenance } from './ha-control-plane.js';
import { readHousekeepingOwner, requireHousekeepingIncarnation } from './housekeeping-owner.js';

/** Authenticated UI management requests only. No general service locator, retry, or archive buffering. */
export const routeMaintenanceOwner: RequestHandler = (req, res, next) => {
  if (process.env.RIVET_HA_DEPLOYMENT !== '1' || req.path === '/import') return next();
  const release = retainRequestWork(req);
  void (async () => {
    if (!req.originalUrl.startsWith('/') || req.originalUrl.startsWith('//') || req.originalUrl.includes('\\') ||
        !/^\/api\/(?:legacy-restore(?:\/|\?|$)|workflows\/(?:project-bundles|bundles)(?:\/|\?|$))/.test(req.originalUrl))
      throw Error('Maintenance forwarding path is not allowlisted.');
    const match = /^\/api\/workflows\/project-bundles\/([a-f0-9-]{36})(\/download)?$/.exec(req.originalUrl);
    if (req.method === 'GET' && match && sharedBundleArchives) {
      const manifest = await sharedBundleArchives.read(match[1]!);
      if (manifest) {
        if (!match[2]) {
          res.json(manifest.status);
          return;
        }
        const stream = await sharedBundleArchives.open(match[1]!, manifest);
        res
          .type('application/zip')
          .set('Content-Length', String(manifest.status.archiveBytes))
          .set('X-Rivet-Bundle-SHA256', manifest.status.archiveHash!)
          .set('Content-Disposition', `attachment; filename="rivet-project-bundle-${match[1]}.zip"`);
        res.once('close', () => stream.destroy());
        await pipeline(stream, res);
        return;
      }
    }
    const overlap = process.env.RIVET_HA_CONTROL_PLANE_MODE === 'singleton-overlap';
    if (ownsMaintenance()) {
      requireHousekeepingIncarnation(req, res, next);
      return;
    }
    let owner;
    if (overlap) {
      if (req.headers['x-rivet-housekeeping-incarnation'] || req.headers['x-rivet-housekeeping-capability']) {
        res.status(409).json({ code: 'housekeeping_handover', error: 'Housekeeping forwarding loop rejected.' });
        return;
      }
      try {
        owner = await readHousekeepingOwner();
      } catch {
        res.status(503).json({
          code: 'housekeeping_handover',
          error: 'Maintenance handover in progress. Try again; this request was not retried.',
        });
        return;
      }
    }
    const upstream = new URL(
      owner
        ? `http://${owner.address.includes(':') ? `[${owner.address}]` : owner.address}:${owner.port}`
        : process.env.RIVET_HA_MAINTENANCE_URL || '',
    );
    if (
      upstream.protocol !== 'http:' ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== '/' ||
      (!/^[a-z0-9.-]+$/.test(upstream.hostname) && !(owner && isIP(upstream.hostname.replace(/^\[|\]$/g, ''))))
    )
      throw new Error('Maintenance owner identity invalid');
    const outgoing = request(new URL(req.originalUrl, upstream), {
      method: req.method,
      headers: {
        ...req.headers,
        ...(owner
          ? {
              'x-rivet-housekeeping-incarnation': owner.incarnation,
              'x-rivet-housekeeping-capability': owner.capability,
            }
          : {}),
      },
    });
    outgoing.setTimeout(30000, () => outgoing.destroy(new Error('Maintenance forwarding timed out.')));
    outgoing.on('error', () => {
      if (res.headersSent) res.destroy();
      else res.status(503).json({ code: 'housekeeping_owner_unavailable', outcome: 'unknown',
        error: 'Maintenance owner unavailable. This request was not retried. Check its existing operation status before retrying.' });
    });
    outgoing.on('response', (response) => {
      res.status(response.statusCode ?? 503);
      for (const [name, value] of Object.entries(response.headers))
        if (value != null && !['connection', 'transfer-encoding'].includes(name)) res.setHeader(name, value);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    req.once('aborted', () => outgoing.destroy());
    res.once('close', () => outgoing.destroy());
    req.pipe(outgoing);
  })().then(release, (error) => {
    release();
    next(error);
  });
};
