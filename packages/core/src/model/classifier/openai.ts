import type { ClassifierEntry, ClassifierEvaluationResponse, PreparedClassifierQuestion } from './types.js';
import type { PreparedClassifierEvaluation } from './providers.js';
import { validateClassifierEvaluationResponse } from './response.js';

function text(value: ClassifierEntry): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** OpenAI's Decisions schema is not the System One protocol. */
export function createOpenAIDecisionRequest(args: PreparedClassifierEvaluation): Record<string, unknown> {
  const state = args.state;
  return {
    model: args.model,
    input:
      state.kind === 'messages'
        ? state.messages.map(({ parts }) => ({
            role: 'user',
            content: parts.map((part) =>
              part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : { type: 'input_image', image_url: part.dataUrl },
            ),
          }))
        : typeof state.value === 'string'
          ? state.value
          : JSON.stringify(state.value),
    questions: args.questions.map((question) => {
      const common = { name: question.questionId, instructions: text(question.instructions) };
      if (question.type === 'choice')
        return {
          ...common,
          type: 'choice',
          choices: Object.entries(question.criteria).map(([value, description]) => ({
            value,
            ...(description === null ? {} : { description: text(description) }),
          })),
        };
      if (question.type === 'score')
        return {
          ...common,
          type: 'score',
          levels: question.criteria.map((entry) => ({ label: text(entry) })),
        };
      const criteria = question.criteria;
      return {
        ...common,
        type: 'predicate',
        instructions: criteria
          ? `${common.instructions}\n\nTrue criterion: ${text(criteria.true)}\nFalse criterion: ${text(criteria.false)}`
          : common.instructions,
      };
    }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: Record<string, unknown>, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, name) ? value[name] : undefined;
}

export function validateOpenAIDecisionResponse(
  body: unknown,
  questions: readonly PreparedClassifierQuestion[],
  providerLabel = 'OpenAI',
): ClassifierEvaluationResponse {
  const nativeAnswers = record(body) ? field(body, 'answers') : undefined;
  if (!record(body) || !Array.isArray(nativeAnswers) || nativeAnswers.length !== questions.length) {
    throw new Error(`${providerLabel} returned an invalid response shape.`);
  }
  const answers = Object.create(null) as Record<string, unknown>;
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index]!;
    const answer: unknown = nativeAnswers[index];
    if (!record(answer) || field(answer, 'name') !== question.questionId) {
      throw new Error(`${providerLabel} response does not match the submitted question IDs/order.`);
    }
    const type = field(answer, 'type');
    if (type === 'refusal') throw new Error(`${providerLabel} refused question '${question.questionId}'.`);
    if (type !== (question.type === 'noul' ? 'predicate' : question.type)) {
      throw new Error(`${providerLabel} response type does not match question '${question.questionId}'.`);
    }
    let mapped: Record<string, unknown>;
    if (question.type === 'noul') mapped = { type: 'noul', noul: field(answer, 'probability') };
    else {
      const entries = field(answer, 'probabilities');
      if (!Array.isArray(entries)) throw new Error(`${providerLabel} response has invalid probabilities.`);
      const probabilities = Object.create(null) as Record<string, unknown>;
      const legend = Object.create(null) as Record<string, unknown>;
      for (const entry of entries as unknown[]) {
        if (!record(entry)) throw new Error(`${providerLabel} response has invalid probability entry.`);
        const value = field(entry, 'value');
        if (
          question.type === 'choice'
            ? typeof value !== 'string'
            : typeof value !== 'number' || !Number.isSafeInteger(value)
        ) {
          throw new Error(`${providerLabel} response has invalid probability key.`);
        }
        const key = String(value);
        if (Object.prototype.hasOwnProperty.call(probabilities, key)) {
          throw new Error(`${providerLabel} response has duplicate probability keys.`);
        }
        Object.defineProperty(probabilities, key, { enumerable: true, value: field(entry, 'probability') });
        if (question.type === 'score') {
          const label = field(entry, 'label');
          if (typeof label !== 'string') throw new Error(`${providerLabel} response has invalid score label.`);
          Object.defineProperty(legend, key, { enumerable: true, value: label });
        }
      }
      mapped = {
        type: question.type,
        confidence: field(answer, 'confidence'),
        probabilities,
        ...(question.type === 'choice'
          ? { choice: field(answer, 'choice') }
          : { score: field(answer, 'score'), legend }),
      };
    }
    Object.defineProperty(answers, question.questionId, { enumerable: true, value: mapped });
  }
  return validateClassifierEvaluationResponse(
    {
      model: field(body, 'model'),
      answers,
      usage: field(body, 'usage'),
    },
    questions,
    providerLabel,
  );
}
