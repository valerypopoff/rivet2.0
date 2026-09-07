import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  extractInterpolationVariableReferences,
  extractInterpolationVariables,
  findInterpolationTokenSpans,
  interpolate,
  parseInterpolationExpression,
  parseInterpolationTemplate,
  parseInterpolationToken,
  replaceInterpolationTokens,
  resolveCodeInterpolationExpression,
  resolveInterpolationExpressionRawValue,
} from '../../src/utils/interpolation.js';
import { evaluateJsonPath } from '../../src/utils/jsonPath.js';
import { scanInterpolationTokenSpans } from '../../src/utils/interpolationSyntax.js';

describe('interpolation utilities', () => {
  it('shares boundary scanning between cached parsing and editor-safe syntax consumers', () => {
    const template = '{{{literal}}} {{broken {{records[?(@.pattern =~ /{{|}}/)].name}} {{valid}}';

    assert.deepStrictEqual(scanInterpolationTokenSpans(template), findInterpolationTokenSpans(template));
  });

  it('extracts valid variables while skipping a broken opener across lines', () => {
    const template = ['{{foo}}', '{{bar', '{{somevar}}'].join('\n');

    assert.deepStrictEqual(extractInterpolationVariables(template), ['foo', 'somevar']);
  });

  it('extracts valid variables while skipping a broken opener on one line', () => {
    const template = '{{foo}}  {{bar  {{somevar}}';

    assert.deepStrictEqual(extractInterpolationVariables(template), ['foo', 'somevar']);
  });

  it('recovers a later token after a broken opener containing an unmatched object brace', () => {
    const template = '{{broken{ {{valid}}';

    assert.deepStrictEqual(extractInterpolationVariables(template), ['valid']);
    assert.equal(
      interpolate(template, {
        valid: { type: 'string', value: 'value' },
      }),
      '{{broken{ value',
    );
  });

  it('recovers a later token from a malformed opener with an unterminated quoted JSONPath segment', () => {
    const template = '{{broken + $.aaa["{{field}}"]';

    assert.deepStrictEqual(extractInterpolationVariables(template), ['field']);
    assert.equal(
      interpolate(template, {
        field: { type: 'string', value: 'value' },
      }),
      '{{broken + $.aaa["value"]',
    );
  });

  it('keeps nested opener text inside a properly closed quoted JSONPath segment', () => {
    const parsed = parseInterpolationTemplate('{{foo.items[?(@.name == "{{literal}}")].name}}');

    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0]?.tokenName, 'foo.items[?(@.name == "{{literal}}")].name');
  });

  it('keeps malformed interpolation text literal while still interpolating later valid tokens', () => {
    const template = '{{foo}}  {{bar  {{somevar}}';

    assert.equal(
      interpolate(template, {
        foo: { type: 'string', value: 'A' },
        somevar: { type: 'string', value: 'B' },
      }),
      'A  {{bar  B',
    );
  });

  it('preserves escaped tokens while interpolating normal ones', () => {
    const template = '{{{foo}}} {{bar}}';

    assert.equal(
      interpolate(template, {
        bar: { type: 'string', value: 'B' },
      }),
      '{{foo}} B',
    );
  });

  it('still recognizes later valid tokens that include processing syntax after malformed text', () => {
    const template = '{{foo | uppercase}} {{bar {{baz | lowercase}}';

    assert.equal(
      interpolate(template, {
        foo: { type: 'string', value: 'abc' },
        baz: { type: 'string', value: 'OK' },
      }),
      'ABC {{bar ok',
    );
  });

  it('replaces tokens through a caller-defined policy while preserving escaped tokens', () => {
    const template = '  {{{escaped}}} {{foo | ignored}} {{missing}}  ';

    assert.equal(
      replaceInterpolationTokens(
        template,
        ({ tokenName }) => {
          return tokenName === 'foo' ? 'BAR' : 'undefined';
        },
        { trim: true },
      ),
      '{{escaped}} BAR undefined',
    );
  });

  it('dedupes repeated variables and ignores graph/context references during port discovery', () => {
    const template = [
      '{{foo}}',
      '{{foo | uppercase}}',
      '{{@graphInputs.shared}}',
      '{{@context.value}}',
      '{{bar}}',
    ].join('\n');

    assert.deepStrictEqual(extractInterpolationVariables(template), ['foo', 'bar']);
  });

  it('discovers one base port for repeated nested JSONPath references', () => {
    const template = [
      '{{foo}}',
      '{{foo.profile.name}}',
      '{{foo.items[0].label}}',
      '{{["literal.name"].value}}',
      '{{bar}}',
      '{{@graphInputs.shared.value}}',
      '{{@context["context.value"].name}}',
    ].join(' ');

    assert.deepStrictEqual(extractInterpolationVariables(template), ['foo', 'literal.name', 'bar']);
    assert.deepStrictEqual(extractInterpolationVariableReferences(template), [
      { baseName: 'foo', hasPath: true },
      { baseName: 'literal.name', hasPath: true },
      { baseName: 'bar', hasPath: false },
    ]);
  });

  it('parses JSONPath suffixes and special namespaces against one base value', () => {
    assert.deepStrictEqual(parseInterpolationExpression('foo.bar.some[0]'), {
      source: 'variable',
      baseName: 'foo',
      jsonPath: '$.bar.some[0]',
    });
    assert.deepStrictEqual(parseInterpolationExpression('foo..price'), {
      source: 'variable',
      baseName: 'foo',
      jsonPath: '$..price',
    });
    assert.deepStrictEqual(parseInterpolationExpression('@context["profile.value"].name'), {
      source: 'context',
      baseName: 'profile.value',
      jsonPath: '$.name',
    });
  });

  it('preserves legacy whitespace around structural JSONPath separators without rewriting filter contents', () => {
    assert.deepStrictEqual(parseInterpolationExpression('@context.user . name'), {
      source: 'context',
      baseName: 'user',
      jsonPath: '$.name',
    });
    assert.deepStrictEqual(parseInterpolationExpression('@graphInputs.foo [ 0 ]'), {
      source: 'graphInputs',
      baseName: 'foo',
      jsonPath: '$[0]',
    });
    assert.deepStrictEqual(parseInterpolationExpression('foo . items[ ?(@.name == "a . b") ]'), {
      source: 'variable',
      baseName: 'foo',
      jsonPath: '$.items[?(@.name == "a . b")]',
    });
    assert.deepStrictEqual(
      resolveInterpolationExpressionRawValue('foo . items[ ?(@.name == "a . b") ]', {
        variables: {
          foo: {
            type: 'object',
            value: { items: [{ name: 'a . b' }, { name: 'other' }] },
          },
        },
      }),
      [{ name: 'a . b' }],
    );
  });

  it('keeps escaped quoted base names raw to match JSONPath-plus property semantics', () => {
    const rawBaseName = 'foo\\u002ebar';
    const expression = '["foo\\u002ebar"].value';

    assert.deepStrictEqual(parseInterpolationExpression(expression), {
      source: 'variable',
      baseName: rawBaseName,
      jsonPath: '$.value',
    });
    assert.deepStrictEqual(extractInterpolationVariables(`{{${expression}}}`), [rawBaseName]);
    assert.equal(
      resolveInterpolationExpressionRawValue(expression, {
        variables: {
          [rawBaseName]: { type: 'object', value: { value: 'raw key' } },
          'foo.bar': { type: 'object', value: { value: 'decoded key' } },
        },
      }),
      'raw key',
    );
  });

  it('normalizes a long filter whitespace run without changing its filter contents', () => {
    const whitespace = ' '.repeat(16 * 1024);

    assert.deepStrictEqual(parseInterpolationExpression(`foo[${whitespace}?(@.name == "a . b") ]`), {
      source: 'variable',
      baseName: 'foo',
      jsonPath: '$[?(@.name == "a . b")]',
    });
  });

  it('uses the same wrap:false JSONPath result as Destructure for nested paths', () => {
    const value = {
      items: [
        { name: 'hidden', enabled: false, score: 0 },
        { name: 'kept', enabled: true, score: 1 },
        { name: 'also-kept', enabled: false, score: 3 },
      ],
    };
    const path = '$.items[?(@.enabled || @.score > 2)].name';

    assert.deepStrictEqual(
      resolveInterpolationExpressionRawValue('foo.items[?(@.enabled || @.score > 2)].name', {
        variables: {
          foo: { type: 'object', value },
        },
      }),
      evaluateJsonPath(value, path, false),
    );
  });

  it('keeps text-template whole-input coercion when the same base also uses a path', () => {
    assert.equal(
      interpolate(
        '{{foo}} / {{foo.profile.name}}',
        {
          foo: { type: 'object', value: { profile: { name: 'Rivet' } } },
        },
        undefined,
        undefined,
        { coerceBareVariableDataValues: true },
      ),
      '{"profile":{"name":"Rivet"}} / Rivet',
    );
  });

  it('keeps generic bare interpolation string conversion safe and lets text templates opt into DataValue coercion', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const variables = {
      array: { type: 'string[]' as const, value: ['first', 'second'] },
      object: { type: 'object' as const, value: { answer: 42 } },
      cyclic: { type: 'object' as const, value: cyclic },
    };

    assert.equal(
      interpolate('{{array}} / {{object}} / {{cyclic}}', variables),
      'first,second / [object Object] / [object Object]',
    );
    assert.equal(
      interpolate('{{array}} / {{object}} / {{object.answer}}', variables, undefined, undefined, {
        coerceBareVariableDataValues: true,
      }),
      'first\nsecond / {"answer":42} / 42',
    );
  });

  it('keeps a nested ordinary type/value object intact after path selection', () => {
    const nestedValue = { type: 'string', value: 'ordinary JSON object' };

    assert.deepStrictEqual(
      resolveInterpolationExpressionRawValue('foo.payload', {
        variables: {
          foo: {
            type: 'object',
            value: { payload: nestedValue },
          },
        },
      }),
      nestedValue,
    );
  });

  it('does not unwrap a raw JSON source whose root happens to look like a DataValue', () => {
    const rawJson = { type: 'string', value: 'ordinary JSON' };

    assert.equal(
      resolveInterpolationExpressionRawValue('foo.value', {
        variables: { foo: rawJson },
        unwrapVariableDataValues: false,
      }),
      'ordinary JSON',
    );
    assert.equal(
      interpolate('{{foo}}', { foo: rawJson }, undefined, undefined, {
        unwrapVariableDataValues: false,
      }),
      '[object Object]',
    );
  });

  it('does not split JSONPath filter pipes from text processor chains', () => {
    const token = parseInterpolationToken('foo.items[?(@.name == "a|b" || @.enabled)].name | uppercase');

    assert.equal(token.tokenName, 'foo.items[?(@.name == "a|b" || @.enabled)].name');
    assert.equal(token.processingChain, 'uppercase');
    assert.equal(
      interpolate('{{foo.items[?(@.name == "a|b" || @.enabled)].name | uppercase}}', {
        foo: {
          type: 'object',
          value: {
            items: [
              { name: 'a|b', enabled: false },
              { name: 'second', enabled: true },
            ],
          },
        },
      }),
      '["A|B","SECOND"]',
    );
  });

  it('keeps delimiter-looking characters inside JSONPath filter syntax within one token', () => {
    const parsed = parseInterpolationTemplate('{{foo.items[?(@.pattern =~ /}}/)].name}}');

    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0]?.tokenName, 'foo.items[?(@.pattern =~ /}}/)].name');
  });

  it('keeps nested-opening characters inside JSONPath regex literals within one token', () => {
    const parsed = parseInterpolationTemplate('{{foo.items[?(@.pattern =~ /\\{\\{/)].name}}');

    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0]?.tokenName, 'foo.items[?(@.pattern =~ /\\{\\{/)].name');
  });

  it('keeps JSONPath object literals inside one valid token', () => {
    const parsed = parseInterpolationTemplate('{{foo.items[?(@.meta == {"name":"Rivet"})].name}}');

    assert.equal(parsed.tokens.length, 1);
    assert.equal(parsed.tokens[0]?.tokenName, 'foo.items[?(@.meta == {"name":"Rivet"})].name');
  });

  it('keeps regex character classes and pipes inside JSONPath filters out of processor parsing', () => {
    const token = parseInterpolationToken('foo.items[?(@.pattern =~ /[\\]]|a|b/)].name | uppercase');

    assert.equal(token.tokenName, 'foo.items[?(@.pattern =~ /[\\]]|a|b/)].name');
    assert.equal(token.processingChain, 'uppercase');
  });

  it('ignores empty and whitespace-only tokens during port discovery', () => {
    assert.deepStrictEqual(extractInterpolationVariables('{{}} {{   }} {{valid}}'), ['valid']);
  });

  it('applies processor chains after resolving graph and context references', () => {
    assert.equal(
      interpolate(
        '{{@graphInputs.name | uppercase}} {{@context.label | lowercase}}',
        {},
        {
          name: { type: 'string', value: 'Rivet' },
        },
        {
          label: { type: 'string', value: 'WORKFLOW' },
        },
      ),
      'RIVET workflow',
    );
  });

  it('resolves graph and context JSONPath expressions without creating ports', () => {
    const template = '{{@graphInputs.profile.user.name}} / {{@context.rows[0].label}}';

    assert.deepStrictEqual(extractInterpolationVariables(template), []);
    assert.equal(
      interpolate(
        template,
        {},
        {
          profile: { type: 'object', value: { user: { name: 'Rivet' } } },
        },
        {
          rows: { type: 'object[]', value: [{ label: 'Studio' }] },
        },
      ),
      'Rivet / Studio',
    );
  });

  it('handles escaped tokens adjacent to real tokens without merging them', () => {
    assert.equal(
      interpolate('{{{literal}}}{{real}}{{{again}}}', {
        real: { type: 'string', value: 'VALUE' },
      }),
      '{{literal}}VALUE{{again}}',
    );
  });

  it('does not reinterpret escaped-token syntax returned by an interpolation value', () => {
    assert.equal(
      interpolate('before {{foo}} after', {
        foo: { type: 'string', value: '{{{bar}}}' },
      }),
      'before {{{bar}}} after',
    );
    assert.equal(
      interpolate('before {{foo}} after', {
        foo: { type: 'string', value: '\\{\\{bar\\}\\}' },
      }),
      'before \\{\\{bar\\}\\} after',
    );
  });

  it('keeps cached expression syntax isolated from caller mutation and current values', () => {
    const firstParse = parseInterpolationExpression('foo.items[0]');
    assert.ok(firstParse);
    firstParse.baseName = 'mutated';
    firstParse.jsonPath = '$.other';

    assert.deepStrictEqual(parseInterpolationExpression('foo.items[0]'), {
      source: 'variable',
      baseName: 'foo',
      jsonPath: '$.items[0]',
    });
    assert.equal(
      resolveCodeInterpolationExpression({ foo: { type: 'object', value: { items: ['first'] } } }, 'foo.items[0]'),
      'first',
    );
    assert.equal(
      resolveCodeInterpolationExpression({ foo: { type: 'object', value: { items: ['second'] } } }, 'foo.items[0]'),
      'second',
    );
  });

  it('keeps escaped path tokens literal while resolving regular path tokens', () => {
    assert.equal(
      interpolate('{{{foo.profile.name}}} {{foo.profile.name}}', {
        foo: { type: 'object', value: { profile: { name: 'Rivet' } } },
      }),
      '{{foo.profile.name}} Rivet',
    );
    assert.deepStrictEqual(extractInterpolationVariables('{{{foo.profile.name}}} {{foo.profile.name}}'), ['foo']);
  });

  it('exposes the same raw resolver to isolated JavaScript runners', () => {
    assert.equal(
      resolveCodeInterpolationExpression(
        {
          foo: { type: 'object', value: { values: [10, 20] } },
        },
        'foo.values[1]',
      ),
      20,
    );
  });

  it('does not throw while scanning malformed brace-heavy templates', () => {
    const templates = [
      '',
      '{',
      '}',
      '{{',
      '}}',
      '{{{',
      '}}}',
      '{{a',
      'a}}',
      '{{a}}{{',
      '{{a} } {{b}}',
      '{{a{{b}}',
      '{{{escaped}}} {{real}} {{broken',
      Array.from({ length: 40 }, (_, index) => (index % 3 === 0 ? '{{x}}' : '{')).join(''),
    ];

    for (const template of templates) {
      assert.doesNotThrow(() => extractInterpolationVariables(template), template);
      assert.doesNotThrow(
        () =>
          replaceInterpolationTokens(template, ({ tokenName }) => {
            return tokenName ?? '';
          }),
        template,
      );
    }
  });

  it('keeps repeated large templates to unique variables only', () => {
    const template = Array.from({ length: 250 }, (_, index) => `{{same}} {{value${index % 5}}}`).join(' ');

    assert.deepStrictEqual(extractInterpolationVariables(template), [
      'same',
      'value0',
      'value1',
      'value2',
      'value3',
      'value4',
    ]);
  });

  it('returns independent extraction arrays when a template is cached', () => {
    const template = '{{first}} {{second}} {{first}}';
    const firstExtraction = extractInterpolationVariables(template);

    firstExtraction.push('mutated');
    const cachedExtraction = extractInterpolationVariables(template);
    cachedExtraction.push('also-mutated');

    assert.deepStrictEqual(extractInterpolationVariables(template), ['first', 'second']);
  });

  it('keeps extraction correct after many distinct templates and a later hot template', () => {
    for (let index = 0; index < 2500; index++) {
      assert.deepStrictEqual(extractInterpolationVariables(`{{value${index}}} {{shared}}`), [
        `value${index}`,
        'shared',
      ]);
    }

    const hotTemplate = '{{hot}} {{again}}';
    assert.deepStrictEqual(extractInterpolationVariables(hotTemplate), ['hot', 'again']);
    assert.deepStrictEqual(extractInterpolationVariables(hotTemplate), ['hot', 'again']);
  });
});
