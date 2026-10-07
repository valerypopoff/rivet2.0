import {
  assertClassifierEntryKind,
  assertClassifierInstructionsKind,
  assertClassifierJson,
  classifierArrayValues,
} from './json.js';
import type { ClassifierQuestionDefinition, ClassifierEntry } from './types.js';
import type { ClassifierPreparationCheck } from './limits.js';

/** Shared by node execution and direct provider calls, before taking the request snapshot. */
export function validateClassifierQuestion(
  value: unknown,
  check?: ClassifierPreparationCheck,
): asserts value is ClassifierQuestionDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Question inputs must contain question definition objects.');
  if ('images' in value)
    throw new Error("Question-level images are not supported. Connect images to Classifier Evaluate's State input.");
  // Optional envelope properties may be undefined; structured entries themselves must be exact JSON.
  assertClassifierJson(value, 'Question', true, check);
  const question = value as ClassifierQuestionDefinition;
  for (const key of ['questionId', 'type', 'instructions']) {
    if (!Object.prototype.propertyIsEnumerable.call(question, key))
      throw new Error(`Every classifier question must have an own, enumerable '${key}' field.`);
  }
  if (typeof question.questionId !== 'string' || question.questionId.trim() === '')
    throw new Error('Every classifier question must have a non-empty Question ID.');
  if (!['choice', 'score', 'noul'].includes(question.type))
    throw new Error(`Question '${question.questionId}' has an unsupported type.`);
  // The whole question has already passed recursive JSON/resource validation.
  // Check only entry kinds here; do not scan each structured entry again.
  assertClassifierInstructionsKind(question.instructions, `Question '${question.questionId}' instructions`);
  const criteriaProperty = Object.getOwnPropertyDescriptor(question, 'criteria');
  if (criteriaProperty && (!criteriaProperty.enumerable || !('value' in criteriaProperty)))
    throw new Error(`Question '${question.questionId}' criteria must be an own, enumerable field.`);
  const criteria = criteriaProperty?.value;
  if (question.type === 'choice') {
    if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria))
      throw new Error(`Choice question '${question.questionId}' requires object criteria.`);
    const keys = Object.keys(criteria);
    if (keys.length < 2 || keys.length > 255)
      throw new Error(`Choice question '${question.questionId}' requires 2 to 255 options.`);
    for (const key of keys)
      assertClassifierEntryKind(
        (criteria as Record<string, unknown>)[key],
        `Question '${question.questionId}' criteria.${key}`,
      );
  } else if (question.type === 'score') {
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10)
      throw new Error(`Score question '${question.questionId}' requires 2 to 10 levels.`);
    let index = 0;
    for (const entry of classifierArrayValues(criteria, 'Criteria'))
      assertClassifierEntryKind(entry, `Question '${question.questionId}' criteria[${index++}]`);
  } else if (criteria !== undefined) {
    if (
      typeof criteria !== 'object' ||
      criteria === null ||
      Array.isArray(criteria) ||
      !Object.prototype.propertyIsEnumerable.call(criteria, 'true') ||
      !Object.prototype.propertyIsEnumerable.call(criteria, 'false')
    )
      throw new Error(`Noul question '${question.questionId}' criteria must contain true and false entries.`);
    const entries = criteria as Record<string, ClassifierEntry>;
    assertClassifierEntryKind(entries.true, `Question '${question.questionId}' criteria.true`);
    assertClassifierEntryKind(entries.false, `Question '${question.questionId}' criteria.false`);
  }
}
