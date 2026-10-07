import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClassifierQuestionNodeImpl, type InternalProcessContext } from '../../../src/index.js';
import { assertClassifierJson } from '../../../src/model/classifier/json.js';

test('Question JSON validation returns the same UTF-8 budget it enforces', () => {
  const value = { text: 'Unicode \u4e16\u754c, quotes " and newline\n', nested: [true, null, 12.5] };
  const bytes = assertClassifierJson(value, 'Question preparation', true);
  assert.ok(bytes >= Buffer.byteLength(JSON.stringify(value)));
  assert.equal(assertClassifierJson(value, 'Question preparation', true, undefined, bytes), bytes);
  assert.throws(
    () => assertClassifierJson(value, 'Question preparation', true, undefined, bytes - 1),
    /resource limit/,
  );
});

function fixture(
  data: Partial<ClassifierQuestionNodeImpl['data']> = {},
  context: Partial<InternalProcessContext> = {},
) {
  const node = ClassifierQuestionNodeImpl.create();
  const impl = new ClassifierQuestionNodeImpl({
    ...node,
    data: { ...node.data, questionType: 'noul', questionId: 'q', instructions: 'Check', ...data },
  });
  return {
    impl,
    context: {
      signal: new AbortController().signal,
      getGlobal: () => undefined,
      graphInputNodeValues: {},
      contextValues: {},
      ...context,
    } as InternalProcessContext,
  };
}

test('Question preparation shares one expanded-work budget across active inputs and resets it per run', async () => {
  const { impl, context } = fixture({
    useInstructionsInput: true,
    criteriaType: 'object',
    useNoulTrueCriteriaInput: true,
    useNoulFalseCriteriaInput: true,
  });
  const entry = (size: number) => ({ type: 'object' as const, value: { items: Array(size).fill(false) } });
  await assert.rejects(
    impl.process({ instructions: entry(60_000), criteriaTrue: entry(60_000), criteriaFalse: entry(1) }, context),
    /too many expanded values/,
  );
  const inputs = { instructions: entry(20_000), criteriaTrue: entry(20_000), criteriaFalse: entry(20_000) };
  const first = await impl.process(inputs, context);
  const second = await impl.process(inputs, context);
  assert.deepEqual(second, first);
  assert.equal((first.question!.value as any).instructions.items.length, 20_000);
});

test('Question cancellation prevents interpolation and stops after a global resolver aborts', async () => {
  const controller = new AbortController();
  let calls = 0;
  const { impl, context } = fixture(
    { instructions: '{{@globals.a}}{{@globals.b}}' },
    {
      signal: controller.signal,
      getGlobal: () => {
        calls++;
        controller.abort(new Error('cancelled'));
        return { type: 'string', value: 'x' };
      },
    },
  );
  await assert.rejects(impl.process({}, context), /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(impl.process({}, context), /cancelled/);
  assert.equal(calls, 1);
});

test('Impossible Score and Choice cardinalities fail before resolving instructions or criteria', async () => {
  let calls = 0;
  for (const data of [
    { questionType: 'score' as const, scoreCriteria: undefined, levels: Array(11).fill('{{@globals.a}}') },
    { questionType: 'choice' as const, options: Array(256).fill({ key: 'a', value: '{{@globals.a}}' }) },
  ]) {
    const { impl, context } = fixture(
      { ...data, instructions: '{{@globals.a}}' },
      {
        getGlobal: () => {
          calls++;
          return { type: 'string', value: 'x' };
        },
      },
    );
    await assert.rejects(impl.process({}, context), /require 2 to/);
  }
  assert.equal(calls, 0);
});

test('Question JSON depth is bounded before JSON.parse allocation, including interpolated JSON', async () => {
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    parses++;
    return original(...args);
  };
  try {
    const { impl, context } = fixture({
      instructionsType: 'object',
      instructionsObjectTemplate: '{"x":'.repeat(65) + '0' + '}'.repeat(65),
    });
    await assert.rejects(impl.process({}, context), /nesting depth/);
    assert.equal(parses, 0);
    const valid = fixture({
      instructionsType: 'object',
      instructionsObjectTemplate: '{"x": "[not structure]", "value": {{value}}}',
    });
    const output = await valid.impl.process(
      { value: { type: 'object', value: { text: 'quoted " text', nested: [1, true, null] } } },
      valid.context,
    );
    assert.deepEqual((output.question!.value as any).instructions, {
      x: '[not structure]',
      value: { text: 'quoted " text', nested: [1, true, null] },
    });
    assert.equal(parses, 1);
  } finally {
    JSON.parse = original;
  }
});

test('Question bounds cumulative template expansion and processor allocation before creating huge strings', async () => {
  for (const processor of ['indent 1000000000', 'quote 1000000000', 'list 1000000000']) {
    const { impl, context } = fixture({ instructions: `{{value | ${processor}}}` });
    await assert.rejects(
      impl.process({ value: { type: 'string', value: 'line\nline' } }, context),
      /processor exceeds/,
    );
  }
  const { impl, context } = fixture({ instructions: '{{value}}'.repeat(40) });
  await assert.rejects(
    impl.process({ value: { type: 'string', value: 'x'.repeat(1024 * 1024) } }, context),
    /budget|resource limit/,
  );
});

test('Question interpolation rejects getters and strips string-conversion hooks without executing them', async () => {
  let executions = 0;
  const value = Object.defineProperty({}, 'field', {
    enumerable: true,
    get: () => {
      executions++;
      return 'bad';
    },
  });
  const { impl, context } = fixture({ instructions: '{{value.field}}' });
  await assert.rejects(impl.process({ value: { type: 'object', value } }, context), /accessors/);
  const safe = {
    field: 'ok',
    [Symbol.toPrimitive]: () => {
      executions++;
      return 'bad';
    },
  };
  const plain = fixture({ instructions: '{{value}}/{{value.field}}' });
  const output = await plain.impl.process({ value: { type: 'object', value: safe } }, plain.context);
  assert.equal((output.question!.value as any).instructions, '[object Object]/ok');
  assert.equal(executions, 0);
  for (const useInstructionsInput of [false, true]) {
    const guarded = fixture({ useInstructionsInput, instructions: '{{instructions}}' });
    const inputs = Object.defineProperty({}, 'instructions', {
      enumerable: true,
      get: () => {
        executions++;
        return { type: 'string', value: 'bad' };
      },
    });
    await assert.rejects(guarded.impl.process(inputs, guarded.context), /accessors/);
  }
  const unused = Object.defineProperty({}, 'unused', {
    enumerable: true,
    get: () => {
      executions++;
      return { type: 'string', value: 'bad' };
    },
  });
  const untouched = fixture();
  await untouched.impl.process(unused, untouched.context);
  assert.equal(executions, 0);
});

test('Question preparation deadline and temporary processor/token arrays are bounded', async () => {
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const { impl, context } = fixture(
      { instructions: '{{@globals.a}}' },
      {
        getGlobal: () => {
          clock += 30_000;
          return { type: 'string', value: 'x' };
        },
      },
    );
    await assert.rejects(impl.process({}, context), /timed out/);
  } finally {
    Date.now = now;
  }
  for (const processor of ['sort', 'indent 0', 'wrap 80']) {
    const { impl, context } = fixture({ instructions: `{{value | ${processor}}}` });
    await assert.rejects(
      impl.process({ value: { type: 'string', value: 'x\n'.repeat(100_001) } }, context),
      /too many expanded pieces/,
    );
  }
  const tokens = fixture({ instructions: '{{a}}'.repeat(100_001) });
  await assert.rejects(tokens.impl.process({}, tokens.context), /too many tokens/);
});

test('Question snapshots preserve missing typed values and ignore caller-defined line mappers', async () => {
  const missing = fixture({ instructions: '{{value}}' });
  await assert.rejects(
    missing.impl.process({ value: { type: 'string', value: undefined } } as any, missing.context),
    /Instructions are required/,
  );
  const lines = ['First', 'Second'];
  Object.defineProperty(lines, 'map', {
    value: () => {
      throw new Error('Must not call authored mapper');
    },
  });
  const question = fixture({ instructionsType: 'lines', instructionsLines: lines });
  const output = await question.impl.process({}, question.context);
  assert.deepEqual((output.question!.value as any).instructions, lines.slice());
});
