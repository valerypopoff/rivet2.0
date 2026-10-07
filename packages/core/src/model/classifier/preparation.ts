import type { InterpolationGuard } from '../../utils/interpolation.js';
import type { InternalProcessContext } from '../ProcessContext.js';
import {
  ClassifierValueBudget,
  classifierPreparationCheck,
  ClassifierResourceLimitError,
  CLASSIFIER_LIMITS,
} from './limits.js';

/** One cumulative budget for authored templates, referenced values and resolved entries. */
export class ClassifierQuestionPreparation implements InterpolationGuard {
  readonly tokenLimit = CLASSIFIER_LIMITS.values;
  private readonly budget: ClassifierValueBudget;
  private operations = 0;
  private readonly deadlineCheck: () => void;

  constructor(context: Pick<InternalProcessContext, 'signal'>) {
    this.deadlineCheck = classifierPreparationCheck(context.signal, Date.now() + 30_000, 30_000);
    this.budget = new ClassifierValueBudget(this.check);
    this.check();
  }

  check = (): void => {
    this.deadlineCheck();
    if (++this.operations > CLASSIFIER_LIMITS.values * 10)
      throw new ClassifierResourceLimitError('Classifier question preparation has too much expanded work.');
  };

  capture(value: unknown): void {
    this.inspect(value, false);
  }

  prepareValue = (value: unknown): unknown => this.inspect(value, true);

  private inspect(value: unknown, copy: boolean): unknown {
    if (value === undefined) {
      this.check();
      return value;
    }
    return this.budget.inspect(value, {
      label: 'Question preparation',
      allowUndefinedProperties: true,
      copy,
    }).value;
  }

  output = (fragment: string, previousLength: number): void => {
    this.check();
    // Reject before concatenation. Exact UTF-8/JSON bytes are charged when
    // the completed entry is captured; this bounds intermediate allocations.
    if (fragment.length + previousLength > this.budget.remainingBytes)
      throw new ClassifierResourceLimitError('Classifier question interpolation exceeds its remaining byte budget.');
  };

  processing = (input: string, name: string, parameter: number | undefined): void => {
    this.check();
    if (['chain', 'sort', 'dedent', 'wrap', 'indent', 'quote', 'list'].includes(name)) {
      let pieces = 1;
      let whitespace = false;
      for (let i = 0; i < input.length; i++) {
        if ((i & 4095) === 0) this.check();
        const nextWhitespace = /\s/.test(input[i]!);
        if (
          (name === 'chain' && input[i] === '|') ||
          ((name === 'chain' || name === 'wrap') && nextWhitespace && !whitespace) ||
          (name !== 'chain' && name !== 'wrap' && input[i] === '\n')
        ) {
          if (++pieces > CLASSIFIER_LIMITS.values)
            throw new ClassifierResourceLimitError('Classifier interpolation processor has too many expanded pieces.');
        }
        whitespace = nextWhitespace;
      }
    }
    if (name !== 'indent' && name !== 'quote' && name !== 'list') return;
    const value = parameter ?? (name === 'indent' ? 0 : 1);
    const prefix = name === 'indent' ? value : name === 'quote' ? value * 2 : (value - 1) * 2 + 2;
    if (!Number.isSafeInteger(value) || value < (name === 'list' ? 1 : 0))
      throw new Error(`Invalid classifier interpolation ${name} parameter.`);
    let lines = 1;
    for (let i = 0; i < input.length; i++) {
      if ((i & 4095) === 0) this.check();
      if (input[i] === '\n') lines++;
    }
    if (input.length + lines * prefix > this.budget.remainingBytes)
      throw new ClassifierResourceLimitError('Classifier interpolation processor exceeds its remaining byte budget.');
  };
}
