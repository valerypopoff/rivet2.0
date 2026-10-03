import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { developmentFrontendEnv } from '../../../deploy/studio-server/scripts/lib/dev-env.mjs';

test('frontend mode selects bounded startup grace without changing live defaults', () => {
  assert.deepEqual(developmentFrontendEnv(), { RIVET_DEV_FRONTEND_MODE: 'live', RIVET_DEV_WEB_START_PERIOD: '180s' });
  assert.deepEqual(developmentFrontendEnv('tunnel'), {
    RIVET_DEV_FRONTEND_MODE: 'tunnel',
    RIVET_DEV_WEB_START_PERIOD: '900s',
  });
  assert.throws(() => developmentFrontendEnv('production'), /Frontend mode/);
});

test('tunnel mode reuses the dev launcher/project and preserves UI authorization for SSE', async () => {
  const root = new URL('../../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(
    manifest.scripts['studio-server:dev:tunnel'],
    'node deploy/studio-server/scripts/dev-docker.mjs dev tunnel',
  );
  const compose = await readFile(new URL('deploy/studio-server/compose/docker-compose.dev.yml', root), 'utf8');
  const web = parse(compose).services.web;
  const proxyService = parse(compose).services.proxy;
  assert.notEqual(proxyService.depends_on.web.restart, true, 'Frontend switches must not disconnect executor sockets');
  assert.ok(web.environment.includes('RIVET_DEV_FRONTEND_MODE=${RIVET_DEV_FRONTEND_MODE:-live}'));
  assert.ok(web.volumes.includes('tunnel_cache:/home/rivet/.cache/tunnel'));
  assert.equal(web.init, true);
  assert.equal(web.healthcheck.start_period, '${RIVET_DEV_WEB_START_PERIOD:-180s}');
  assert.match(web.command, /if \[ \$\$RIVET_DEV_FRONTEND_MODE = tunnel \]/);
  assert.match(web.command, /dev\/tunnel\.mjs/);
  assert.match(web.command, /check:google-hosted-override &&/);
  assert.match(web.command, /run dev --host 0\.0\.0\.0 --strictPort/);
  const proxy = await readFile(new URL('deploy/studio-server/compose/nginx/default.dev.conf.template', root), 'utf8');
  const location = proxy.match(/location = \/__rivet_dev\/events \{([^}]+)\}/)![1]!;
  assert.match(location, /auth_request \/__rivet_ui_auth_check/);
  assert.match(location, /proxy_buffering off/);
  assert.match(location, /proxy_set_header Connection ""/);
  const production = await readFile(new URL('deploy/studio-server/compose/nginx/default.conf.template', root), 'utf8');
  assert.doesNotMatch(production, /__rivet_dev\/events/);
});
