import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';

/** Publish an older certified UI into this disposable installation's retained
 * asset namespace. The publisher has no Service and is removed before rollout. */
export async function publishHaBrowserBaseline(gate, image) {
  await (gate.assertProofContext ?? gate.assertLocalContext).call(gate);
  assert.ok(image?.repository && /^sha256:[a-f0-9]{64}$/.test(image.digest), 'baseline must be an immutable image');
  const kube = (args, extra = {}) => gate.kubectl(['-n', gate.config.namespace, ...args], { capture: true, ...extra });
  const pods = JSON.parse(
    (
      await kube([
        'get',
        'pods',
        '-l',
        `app.kubernetes.io/instance=${gate.config.release},app.kubernetes.io/component=web`,
        '-o',
        'json',
      ])
    ).stdout,
  ).items;
  const template = pods.find((p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'));
  assert.ok(template, 'a ready web template is required for baseline publication');
  const name = `browser-baseline-${randomUUID().slice(0, 8)}`;
  const container = template.spec.containers.find((c) => c.name === 'web');
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name },
    spec: {
      restartPolicy: 'Never',
      securityContext: template.spec.securityContext,
      imagePullSecrets: template.spec.imagePullSecrets,
      volumes: template.spec.volumes,
      containers: [{ ...container, image: `${image.repository}@${image.digest}` }],
    },
  };
  try {
    await kube(['create', '-f', '-'], { input: JSON.stringify(pod) });
    await kube(['wait', '--for=condition=Ready', `pod/${name}`, '--timeout=180s']);
    const result = await kube([
      'exec',
      name,
      '-c',
      'web',
      '--',
      'node',
      '--input-type=module',
      '-e',
      "console.log((await fetch('http://127.0.0.1:3000/')).headers.get('x-rivet-web-build'))",
    ]);
    const build = result.stdout.trim();
    assert.match(build, /^[a-f0-9]{64}$/);
    return { ...image, build };
  } finally {
    await kube(['delete', 'pod', name, '--ignore-not-found', '--wait=true', '--timeout=60s']);
  }
}

/** Actual production dashboard retained across the same release operation as
 * the execution probes. Only disposable fixture browsers are controlled. */
export async function startHaBrowserProbe(gate, baseUrl, rootDir, { build, label = 'predecessor', template } = {}) {
  const { chromium, expect } = createRequire(path.join(rootDir, 'packages/studio-server-web/package.json'))(
    '@playwright/test',
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() =>
    localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'nodejs', recordExecutions: true })),
  );
  const page = await context.newPage();
  const owners = [],
    events = [];
  page.on('websocket', (socket) => {
    const parts = new URL(socket.url()).pathname.split('/');
    if (parts.slice(0, 4).join('/') === '/ws/executor/owner') owners.push(parts[4]);
    socket.on('framereceived', (frame) => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (['start', 'done', 'error', 'executor-owner-retiring', 'executor-session-ready'].includes(message.message)) {
          events.push({
            message: message.message,
            requestId: message.requestId,
            projectId: message.data?.project?.metadata?.id,
          });
          if (events.length > 100) events.shift();
        }
      } catch {
        /* Binary recordings are not protocol diagnostics. */
      }
    });
  });
  const errors = [],
    failedAssets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/__rivet_web/') && response.status() >= 400)
      failedAssets.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  try {
    if (gate.authenticateBrowser) await gate.authenticateBrowser(context);
    const project = parse(template);
    const marker = `browser-${label}-${randomUUID()}`;
    project.data.metadata.id = randomUUID();
    project.data.metadata.title = marker;
    delete project.data.uiGraphs;
    const graph = project.data.graphs[project.data.metadata.mainGraphId];
    graph.nodes = {
      '[browser-value]:text "Browser value"': {
        data: { text: marker },
        visualData: '100/120/260/null//',
        outgoingConnections: ['output->"Browser delay" browser-delay/input1'],
      },
      '[browser-delay]:delay "Browser delay"': {
        data: { delay: 20000, useDelayInput: false },
        visualData: '450/120/260/null//',
        outgoingConnections: ['output1->"Browser result" browser-result/value'],
      },
      '[browser-result]:graphOutput "Browser result"': {
        data: { id: 'result', dataType: 'string' },
        visualData: '800/120/260/null//',
      },
    };
    const upload = await gate.requestWorkflow(baseUrl, '/api/workflows/projects/upload', {
      method: 'POST',
      body: JSON.stringify({
        folderRelativePath: '',
        fileName: `${marker}.rivet-project`,
        contents: stringify(project),
      }),
    });
    const relativePath = upload.project.relativePath;
    const recordings = [];
    page.on('response', async (response) => {
      if (
        new URL(response.url()).pathname !== '/api/workflows/local-editor-recordings' ||
        response.request().method() !== 'POST'
      )
        return;
      const body = response.request().postDataJSON();
      if (body.projectId !== project.data.metadata.id && body.projectId !== upload.project.projectMetadataId) return;
      try {
        recordings.push({ status: response.status(), body, result: await response.json() });
      } catch (error) {
        errors.push(`Recording acknowledgement: ${error.message}`);
      }
    });
    await page.goto(build ? `${baseUrl}/?webBuild=${build}` : baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.getByRole('button', { name: 'Run statistics', exact: true }).waitFor({ timeout: 90_000 });
    const originalBuild = await page.locator('meta[name="rivet-web-build"]').getAttribute('content');
    assert.match(originalBuild ?? '', /^[a-f0-9]{64}$/);
    if (build) assert.equal(originalBuild, build, 'the oldest UI must not silently resolve to the current build');
    const token = randomUUID();
    await page.evaluate((token) => {
      window.__haBrowserContinuity = token;
    }, token);
    const iframe = page.frameLocator('iframe');
    await iframe
      .locator(`meta[name="rivet-web-build"][content="${originalBuild}"]`)
      .waitFor({ state: 'attached', timeout: 90_000 });
    let reloads = 0,
      iframeReloads = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reloads++;
      else if (frame.parentFrame() === page.mainFrame()) iframeReloads++;
    });
    await page.locator('.project-row').filter({ hasText: marker }).dblclick();
    const value = iframe.locator('.node[data-nodeid="browser-value"]');
    const result = iframe.locator('.node[data-nodeid="browser-result"]');
    await expect(value).toBeVisible({ timeout: 90_000 });
    await result.evaluate((node) => {
      const view = node.ownerDocument.defaultView;
      view.__haNodeStates = [{ at: Date.now(), className: node.className }];
      new MutationObserver(() => {
        view.__haNodeStates.push({ at: Date.now(), className: node.className });
        if (view.__haNodeStates.length > 100) view.__haNodeStates.shift();
      }).observe(node, { attributes: true, attributeFilter: ['class'] });
    });
    await iframe.locator('.run-button button').first().click();
    // The real Node execution starts before the upgrade, not a synthetic UI sentinel.
    await expect(iframe.locator('.run-button')).toContainText('Abort', { timeout: 30_000 });
    await value.locator('.edit-button').dispatchEvent('click');
    const input = iframe.locator('.monaco-editor textarea').first();
    await input.focus();
    await input.press('ControlOrMeta+a');
    await input.press('Backspace');
    const edited = `${marker}-unsaved`;
    await page.keyboard.insertText(edited);
    await input.press('Escape');
    await expect(page.locator('.active-project-save-button')).toBeVisible({ timeout: 30_000 });
    const capture = async (stage) => {
      const state = {
        stage,
        errors,
        failedAssets,
        owners,
        events,
        reloads,
        iframeReloads,
        nodeStates: await result.evaluate((node) => node.ownerDocument.defaultView.__haNodeStates),
        unsavedEditVisible: await page.locator('.active-project-save-button').isVisible(),
        recordings: recordings.map((r) => ({
          status: r.status,
          recordingId: r.result.recordingId,
          outcome: r.body.status,
        })),
        resultClass: await result.getAttribute('class'),
        resultText: await result.innerText(),
        runControls: await iframe.locator('.run-button').allTextContents(),
      };
      await gate.artifact(`ha-browser-${label}-${stage}.json`, JSON.stringify(state, null, 2));
      await page.screenshot({ path: path.join(gate.config.artifactsDir, `ha-browser-${label}-${stage}.png`) });
      return state;
    };
    return {
      capture,
      async finish(before) {
        await capture('after-upgrade');
        await expect(result).toHaveClass(/success/, { timeout: 90_000 });
        await expect.poll(() => recordings.length, { timeout: 90_000 }).toBe(1);
        await expect(page.locator('.active-project-save-button')).toBeVisible();
        await value.locator('.edit-button').dispatchEvent('click');
        await expect(iframe.locator('.monaco-editor .view-lines').first()).toContainText(edited);
        await iframe.locator('.monaco-editor textarea').first().press('Escape');
        await page.locator('.active-project-save-button').click();
        await expect(page.locator('.active-project-save-button')).toHaveCount(0, { timeout: 30_000 });
        const saved = await gate.requestWorkflow(baseUrl, '/api/workflows/projects/download', {
          method: 'POST',
          body: JSON.stringify({ relativePath, version: 'live' }),
        });
        assert.ok(saved.includes(edited), 'the actual retained edit must be persisted by the candidate API');
        await iframe.locator('.run-button button').first().click();
        await expect.poll(() => recordings.length, { timeout: 90_000 }).toBe(2);
        await expect(result).toHaveClass(/success/);
        await result.locator('.node-output').hover();
        await result.locator('.expand-button').click();
        await expect(iframe.getByTestId('fullscreen-output-modal')).toContainText(edited);
        await iframe.locator('body').press('Escape');
        assert.deepEqual(
          recordings.map((r) => r.status),
          [201, 201],
        );
        assert.deepEqual(
          recordings.map((r) => r.body.status),
          ['succeeded', 'succeeded'],
        );
        const ids = recordings.map((r) => r.result.recordingId);
        assert.equal(new Set(ids).size, 2, 'exactly one recording per original/new run');
        await page.getByRole('button', { name: 'Run recordings', exact: true }).click();
        const modal = page.getByTestId('run-recordings-modal');
        await expect(modal).toBeVisible();
        const row = modal.locator(`[data-recording-id="${ids[1]}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await row.locator('.run-recordings-run-title').click();
        await expect(modal).toHaveCount(0, { timeout: 90_000 });
        // Opening a recording loads an observational replay project; it does
        // not execute playback automatically. Exercise the existing UI action.
        await iframe.getByRole('button', { name: 'Play Recording', exact: true }).click();
        await expect(result).toHaveClass(/success/, { timeout: 90_000 });
        await result.locator('.node-output').hover();
        await result.locator('.expand-button').click();
        await expect(iframe.getByTestId('fullscreen-output-modal')).toContainText(edited);
        await iframe.locator('body').press('Escape');
        assert.equal(recordings.length, 2, 'observational playback must not submit a third live run');
        await page.getByRole('button', { name: 'Run statistics', exact: true }).click();
        await page.getByRole('dialog', { name: 'Run statistics', exact: true }).waitFor({ timeout: 90_000 });
        assert.equal(await page.evaluate(() => window.__haBrowserContinuity), token);
        assert.equal(reloads, 0, 'upgrades must not reload the open dashboard');
        assert.equal(iframeReloads, 0, 'upgrades must not reload the retained editor');
        const pinned = await context.newPage();
        await pinned.goto(`${baseUrl}/?editor&webBuild=${originalBuild}`, { waitUntil: 'domcontentloaded' });
        assert.equal(await pinned.locator('meta[name="rivet-web-build"]').getAttribute('content'), originalBuild);
        // A fresh load obtains the current build independently of the old tab.
        const fresh = await context.newPage();
        await fresh.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await fresh.getByRole('button', { name: 'Run statistics', exact: true }).waitFor({ timeout: 90_000 });
        const candidateBuild = await fresh.locator('meta[name="rivet-web-build"]').getAttribute('content');
        assert.match(candidateBuild ?? '', /^[a-f0-9]{64}$/);
        const pods = JSON.parse(
          (
            await gate.kubectl(
              [
                '-n',
                gate.config.namespace,
                'get',
                'pods',
                '-l',
                `app.kubernetes.io/instance=${gate.config.release},app.kubernetes.io/component=web`,
                '-o',
                'json',
              ],
              { capture: true },
            )
          ).stdout,
        ).items;
        const originals = before.filter((p) => p.metadata.labels?.['app.kubernetes.io/component'] === 'web');
        assert.ok(originals.length > 0);
        assert.ok(
          originals.every((p) => !pods.some((current) => current.metadata.uid === p.metadata.uid)),
          'all original web pods must be gone',
        );
        assert.deepEqual(failedAssets, []);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(gate.config.artifactsDir, `ha-browser-${label}.png`) });
        return {
          passed: true,
          originalBuild,
          candidateBuild,
          reloads,
          iframeReloads,
          lazyScreen: true,
          pinnedEditor: true,
          oldWebPodsRemoved: true,
          unsavedEdit: true,
          savedByCandidate: true,
          newRun: true,
          outputs: true,
          recordingOpened: true,
          recordingIds: ids,
        };
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
