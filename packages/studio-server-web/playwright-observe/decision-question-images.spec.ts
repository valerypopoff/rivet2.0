import { expect, test } from '@playwright/test';
import { ExecutionRecorder } from '@valerypopoff/rivet2-core';
import { mockHostedEditorBootstrap } from './helpers/hostedEditorObserve';
import { seedHostedEditorProject } from './helpers/hostedEditorStorage';

const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

for (const mode of ['message', 'prompt', 'text-array', 'box'] as const)
  test(`Question Instructions execute in the editor through ${mode}`, async ({ page }) => {
    const withPrompt = mode === 'prompt';
    const withArray = mode === 'text-array';
    const combined = withPrompt || withArray;
    const node = (id: string, type: string, title: string, data: object, x: number) => ({
      id,
      type,
      title,
      data,
      visualData: { x, y: 80, width: 240 },
    });
    const connection = (outputNodeId: string, outputId: string, inputNodeId: string, inputId: string) => ({
      outputNodeId,
      outputId,
      inputNodeId,
      inputId,
    });
    await seedHostedEditorProject(page, {
      projectId: 'question-images',
      graphId: 'main',
      loaded: true,
      projectPath: '/workflows/Question images.rivet-project',
      title: 'Question images',
      graph: {
        nodes: [
          node(
            'image',
            'image',
            'Image',
            { sourceType: 'base64', base64, useDataInput: false, mediaType: 'image/png' },
            0,
          ),
          node('text', 'text', 'Text', { text: 'What is in this picture?' }, 0),
          node(
            'message',
            'assembleMessage',
            'Assemble Message',
            { type: 'user', useTypeInput: false, toolCallId: '' },
            280,
          ),
          ...(withPrompt
            ? [node('prompt', 'assemblePrompt', 'Assemble Prompt', { filterEmptyPrompts: true }, 560)]
            : []),
          ...(withArray ? [node('array', 'array', 'Array', { flatten: true }, 560)] : []),
          node(
            'question',
            'classifierQuestion',
            'Decision AI Question',
            {
              questionType: mode === 'box' ? 'choice' : 'noul',
              questionId: 'q',
              instructions: '',
              useInstructionsInput: true,
              useCriteriaInput: mode === 'box',
            },
            combined ? 840 : 560,
          ),
          node('result', 'graphOutput', 'Result', { id: 'result', dataType: 'object' }, combined ? 1120 : 840),
        ].map((item) => (item.id === 'text' ? { ...item, visualData: { ...item.visualData, y: 400 } } : item)),
        connections: [
          ...(!withArray ? [connection('image', 'image', 'message', 'part1')] : []),
          connection('text', 'output', 'message', withArray ? 'part1' : 'part2'),
          ...(withPrompt
            ? [
                connection('message', 'message', 'prompt', 'message1'),
                connection('prompt', 'prompt', 'question', 'instructions'),
              ]
            : withArray
              ? [
                  connection('message', 'message', 'array', 'input1'),
                  connection('array', 'output', 'question', 'instructions'),
                ]
              : [connection('message', 'message', 'question', 'instructions')]),
          connection('question', 'question', 'result', 'value'),
        ],
      },
    });
    await page.addInitScript(() =>
      localStorage.setItem('recoil-persist', JSON.stringify({ defaultExecutor: 'browser', recordExecutions: true })),
    );
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ status: 503, json: { error: 'No live API in image-question fixture' } }),
    );
    await mockHostedEditorBootstrap(page);
    const recordings: string[] = [];
    await page.route('**/api/workflows/local-editor-recordings**', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { supported: true } });
      if (new URL(route.request().url()).pathname.endsWith('/outcome')) return route.fulfill({ status: 204 });
      recordings.push(route.request().postDataJSON().recordingSerialized);
      return route.fulfill({ status: 201, json: { availability: 'available', recordingId: `q-${recordings.length}` } });
    });
    await page.goto('/?editor', { waitUntil: 'domcontentloaded' });
    const question = page.locator('.node[data-nodeid="question"]');
    await expect(question).toBeVisible();
    if (mode === 'box') {
      await question.locator('button.edit-button').dispatchEvent('click');
      const types = page.getByRole('group', { name: 'Question type', exact: true });
      await expect(question.locator('.port-label', { hasText: /^Criteria$/ })).toHaveCount(1);
      await types.getByRole('button', { name: 'Bounding Box', exact: true }).click();
      await expect(question).toContainText('Type: Bounding Box');
      await expect(question).toContainText('Jev 1.14 and an image');
      await expect(question.locator('.port-label', { hasText: /^Criteria$/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Criteria', exact: true })).toHaveCount(0);
      await types.getByRole('button', { name: 'Choice', exact: true }).click();
      await expect(question.locator('.port-label', { hasText: /^Criteria$/ })).toHaveCount(1);
      await types.getByRole('button', { name: 'Bounding Box', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await page.locator('.run-button button').first().click();
    await expect.poll(() => recordings.length).toBe(1);
    await expect(question).toHaveClass(/success/);
    await expect(page.locator('.node[data-nodeid="result"]')).toHaveClass(/success/);
    const events = ExecutionRecorder.deserializeFromString(recordings[0]!).events;
    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Question graph did not finish');
    expect(done.data.results.result).toEqual({
      type: 'object',
      value: {
        questionId: 'q',
        type: mode === 'box' ? 'box' : 'noul',
        instructions: '',
        instructionsMessages: [
          {
            parts: [
              ...(!withArray ? [{ type: 'image', dataUrl: `data:image/png;base64,${base64}` }] : []),
              { type: 'text', text: 'What is in this picture?' },
            ],
          },
        ],
      },
    });
    await expect(page.locator('.Toastify__toast--error')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('question-image-graph.png') });
  });
