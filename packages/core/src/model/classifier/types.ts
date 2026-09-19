export type ClassifierQuestionType = 'choice' | 'score' | 'noul';
export type ClassifierEntryEditorType = 'text' | 'lines' | 'object';

export type ClassifierStructuredValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: ClassifierStructuredValue }
  | ClassifierStructuredValue[];

export type ClassifierEntry =
  | string
  | null
  | { [key: string]: ClassifierStructuredValue }
  | ClassifierStructuredValue[];

export type ClassifierScoreCriterionData = {
  /** Editor-only stable identity; never leaves Rivet in the provider request. */
  id?: string;
  type: ClassifierEntryEditorType;
  text: string;
  lines: string[];
  objectTemplate: string;
};

/**
 * An authored Choice criterion keeps one value for each supported editor
 * representation. Switching the shared criteria type is therefore
 * non-destructive, just like the Question's Instructions type switch.
 */
export type ClassifierChoiceCriterionData = {
  /** Editor-only stable identity; never leaves Rivet in the provider request. */
  id?: string;
  key: string;
  text: string;
  lines: string[];
  objectTemplate: string;
};

export type ClassifierQuestionDefinition = {
  questionId: string;
  type: ClassifierQuestionType;
  instructions: ClassifierEntry;
  criteria?: unknown;
};

export type ClassifierChoiceQuestionDefinition = ClassifierQuestionDefinition & {
  type: 'choice';
  criteria: Record<string, ClassifierEntry>;
};

export type ClassifierScoreQuestionDefinition = ClassifierQuestionDefinition & {
  type: 'score';
  criteria: ClassifierEntry[];
};

export type ClassifierNoulQuestionDefinition = ClassifierQuestionDefinition & {
  type: 'noul';
  criteria?: { true: ClassifierEntry; false: ClassifierEntry };
};

export type ClassifierEvaluationResponse = {
  model: string;
  answers: Record<string, unknown>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};
