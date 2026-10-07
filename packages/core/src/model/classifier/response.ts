import type {
  ClassifierQuestionDefinition,
  PreparedClassifierQuestion,
  ClassifierEvaluationResponse,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Inherited values are not fields of the provider's JSON response. */
function responseField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function requireResponseNumber(value: unknown, label: string, providerLabel: string): void {
  // Check JSON-compatible representation only, never the provider's numeric
  // range, normalization, precision or derived relationships.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${providerLabel} response has invalid ${label}.`);
  }
}

function requireResponseMap(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
  providerLabel: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${providerLabel} response has invalid ${label}.`);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`${providerLabel} response has inconsistent ${label} keys.`);
  }
  return value;
}

function requireProbabilityMap(value: unknown, keys: readonly string[], label: string, providerLabel: string): void {
  const probabilities = requireResponseMap(value, keys, label, providerLabel);
  for (const key of keys) requireResponseNumber(probabilities[key], `${label}.${key}`, providerLabel);
}

export function validateApiCompatibleClassifierResponse(
  body: unknown,
  questions: readonly ClassifierQuestionDefinition[],
  providerLabel = 'Classifier provider',
): ClassifierEvaluationResponse {
  return validateClassifierEvaluationResponse(body, questions as readonly PreparedClassifierQuestion[], providerLabel);
}

/** Validate the common Rivet result, independently of the provider's wire protocol. */
export function validateClassifierEvaluationResponse(
  body: unknown,
  questions: readonly PreparedClassifierQuestion[],
  providerLabel = 'Classifier provider',
): ClassifierEvaluationResponse {
  const model = isRecord(body) ? responseField(body, 'model') : undefined;
  const answers = isRecord(body) ? responseField(body, 'answers') : undefined;
  const usage = isRecord(body) ? responseField(body, 'usage') : undefined;
  if (!isRecord(body) || typeof model !== 'string' || model.trim() === '' || !isRecord(answers) || !isRecord(usage)) {
    throw new Error(`${providerLabel} returned an invalid response shape.`);
  }
  const expectedIds = questions.map((question) => question.questionId);
  const answerIds = Object.keys(answers);
  if (
    answerIds.length !== expectedIds.length ||
    expectedIds.some((id) => !Object.prototype.hasOwnProperty.call(answers, id))
  ) {
    throw new Error(`${providerLabel} response does not match the submitted question IDs.`);
  }

  for (const question of questions) {
    const answer = answers[question.questionId];
    if (!isRecord(answer) || responseField(answer, 'type') !== question.type) {
      throw new Error(`${providerLabel} response type does not match question '${question.questionId}'.`);
    }
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      const choice = responseField(answer, 'choice');
      if (typeof choice !== 'string' || !Object.prototype.hasOwnProperty.call(question.criteria, choice)) {
        throw new Error(`${providerLabel} response chose an unknown option for '${question.questionId}'.`);
      }
      requireResponseNumber(responseField(answer, 'confidence'), `${question.questionId}.confidence`, providerLabel);
      requireProbabilityMap(
        responseField(answer, 'probabilities'),
        keys,
        `${question.questionId}.probabilities`,
        providerLabel,
      );
    } else if (question.type === 'score') {
      requireResponseNumber(responseField(answer, 'score'), `${question.questionId}.score`, providerLabel);
      requireResponseNumber(responseField(answer, 'confidence'), `${question.questionId}.confidence`, providerLabel);
      const keys = question.criteria.map((_, index) => String(index));
      requireProbabilityMap(
        responseField(answer, 'probabilities'),
        keys,
        `${question.questionId}.probabilities`,
        providerLabel,
      );
      requireResponseMap(responseField(answer, 'legend'), keys, `${question.questionId}.legend`, providerLabel);
    } else {
      requireResponseNumber(responseField(answer, 'noul'), `${question.questionId}.noul`, providerLabel);
    }
  }

  requireResponseNumber(responseField(usage, 'input_tokens'), 'usage.input_tokens', providerLabel);
  requireResponseNumber(responseField(usage, 'output_tokens'), 'usage.output_tokens', providerLabel);
  return body as ClassifierEvaluationResponse;
}
