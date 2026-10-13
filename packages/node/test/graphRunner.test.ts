import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LLMChatV2NodeImpl,
  ClassifierEvaluateNodeImpl,
  TextNodeImpl,
  GraphInputNodeImpl,
  GraphOutputNodeImpl,
  type GraphId,
  type ProjectId,
  type Project,
  type NodeConnection,
} from '@valerypopoff/rivet2-core';
import { createGraphRunner, type CodeRunner, type DataValue, type Inputs, type Outputs } from '../src/index.js';
import {
  makeAbortSignalProject,
  makeAsyncDelayProject,
  makeCodeChainProject,
  makeGlobalStateProject,
  makeInputContextTextProject,
  makeTextChainProject,
} from './runtimeSpeedFixtures.js';

class CountingCodeRunner implements CodeRunner {
  calls = 0;

  async runCode(_code: string, inputs: Inputs): Promise<Outputs> {
    this.calls += 1;
    const inputValue = Number(inputs.input?.value ?? 0);

    return {
      output: { type: 'any', value: inputValue + this.calls },
    } satisfies Outputs;
  }
}

void describe('createGraphRunner', () => {
  void it('returns combined LLM and classifier cost with separate families without Usage outputs', async () => {
    const llm = LLMChatV2NodeImpl.create();
    llm.data.provider = 'openrouter';
    llm.data.model = 'test/model';
    llm.data.outputUsage = false;
    const classifier = ClassifierEvaluateNodeImpl.create();
    classifier.data.provider = 'jev';
    classifier.data.model = 'jev-latest';
    classifier.data.outputUsage = false;
    const prompt = TextNodeImpl.create();
    prompt.data.text = 'Hello';
    const question = GraphInputNodeImpl.create();
    question.data.id = 'question';
    question.data.dataType = 'object';
    const output = GraphOutputNodeImpl.create();
    const id = 'mixed' as GraphId;
    const project: Project = {
      metadata: { id: 'mixed-project' as ProjectId, title: 'Mixed', description: '', mainGraphId: id },
      graphs: {
        [id]: {
          metadata: { id, name: 'Mixed', description: '' },
          nodes: [llm, classifier, prompt, question, output],
          connections: [
            { outputNodeId: prompt.id, outputId: 'output', inputNodeId: llm.id, inputId: 'prompt' },
            { outputNodeId: question.id, outputId: 'data', inputNodeId: classifier.id, inputId: 'question1' },
            { outputNodeId: llm.id, outputId: 'response', inputNodeId: output.id, inputId: 'value' },
          ] as NodeConnection[],
        },
      },
    };
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      return Response.json(
        String(url).includes('openrouter')
          ? {
              id: 'fixture',
              object: 'chat.completion',
              created: 1,
              model: 'test/model',
              choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16, cost: 0.004 },
            }
          : {
              model: classifier.data.model,
              answers: { q: { type: 'noul', noul: 0.8 } },
              usage: { input_tokens: 1_000_000, output_tokens: 0 },
            },
      );
    };
    const runner = createGraphRunner(project, {
      graph: id,
      openRouterApiKey: 'fixture',
      classifierProviders: { jev: { apiKey: 'fixture' } },
    });
    try {
      for (let run = 0; run < 2; run++) {
        const outputs = await runner.run({
          inputs: { question: { type: 'object', value: { questionId: 'q', type: 'noul', instructions: 'Check' } } },
        });
        assert.equal(outputs.cost?.value, 0.004 + 0.042);
        assert.deepEqual(outputs.costBreakdown?.value, { llm: 0.004, classifier: 0.042, other: 0 });
      }
      assert.equal(calls, 4);
    } finally {
      runner.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  void it('reuses stable Node setup while accepting per-run inputs and context', async () => {
    const fixture = makeInputContextTextProject();
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
    });

    const firstOutputs = await runner.run({
      context: { suffix: 'first' },
      inputs: { input: 'a' },
    });
    const secondOutputs = await runner.run({
      context: { suffix: 'second' },
      inputs: { input: 'b' },
    });

    assert.deepEqual(firstOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'string', value: 'a first' },
    } satisfies Record<string, DataValue>);
    assert.deepEqual(secondOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'string', value: 'b second' },
    } satisfies Record<string, DataValue>);
  });

  void it('runs overlapping calls without sharing a running processor', async () => {
    const fixture = makeAsyncDelayProject(20);
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
    });

    const [firstOutputs, secondOutputs] = await Promise.all([
      runner.run({ inputs: { input: 'first' } }),
      runner.run({ inputs: { input: 'second' } }),
    ]);

    assert.deepEqual(firstOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'string', value: 'first' },
    } satisfies Record<string, DataValue>);
    assert.deepEqual(secondOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'string', value: 'second' },
    } satisfies Record<string, DataValue>);
  });

  void it('honors per-run abort signals', async () => {
    const fixture = makeAbortSignalProject(20);
    const controller = new AbortController();
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
      onNodeStart: () => {
        controller.abort();
      },
    });

    await assert.rejects(
      () =>
        runner.run({
          abortSignal: controller.signal,
          inputs: { input: 'abort seed' },
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /failed to process due to errors in nodes/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /Aborted|Processing aborted/);
        return true;
      },
    );
  });

  void it('rejects future runs after dispose', async () => {
    const fixture = makeInputContextTextProject();
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
    });

    runner.dispose();

    await assert.rejects(() => runner.run(), /Cannot run a disposed graph runner/);
  });

  void it('does not leak GraphProcessor globals between runs', async () => {
    const fixture = makeGlobalStateProject();
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
    });

    const firstOutputs = await runner.run({
      inputs: { input: 'first' },
    });
    const secondOutputs = await runner.run({
      inputs: { input: 'second' },
    });

    assert.deepEqual(firstOutputs, {
      cost: { type: 'number', value: 0 },
      previousResult: { type: 'string', value: '' },
    } satisfies Record<string, DataValue>);
    assert.deepEqual(secondOutputs, {
      cost: { type: 'number', value: 0 },
      previousResult: { type: 'string', value: '' },
    } satisfies Record<string, DataValue>);
  });

  void it('prefers custom runtime providers', async () => {
    const fixture = makeCodeChainProject(1);
    const codeRunner = new CountingCodeRunner();
    const runner = createGraphRunner(fixture.project, {
      codeRunner,
      graph: fixture.graphId,
    });

    const firstOutputs = await runner.run({
      inputs: { input: 10 },
    });
    const secondOutputs = await runner.run({
      inputs: { input: 20 },
    });

    assert.equal(codeRunner.calls, 2);
    assert.deepEqual(firstOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'any', value: 11 },
    } satisfies Record<string, DataValue>);
    assert.deepEqual(secondOutputs, {
      cost: { type: 'number', value: 0 },
      result: { type: 'any', value: 22 },
    } satisfies Record<string, DataValue>);
  });

  void it('ignores removed runtime-profile values from untyped callers', async () => {
    const fixture = makeTextChainProject(1);
    const runner = createGraphRunner(fixture.project, {
      graph: fixture.graphId,
      runtimeProfile: 'removed-runtime-profile',
    } as Parameters<typeof createGraphRunner>[1] & { runtimeProfile: string });

    assert.deepEqual(await runner.run({ inputs: { input: 'a' } }), {
      cost: { type: 'number', value: 0 },
      result: { type: 'string', value: 'ax' },
    } satisfies Record<string, DataValue>);
  });
});
