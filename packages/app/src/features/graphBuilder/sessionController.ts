import { type Project, newId } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  canonicalGraphBuilderStringify,
  hashCanonicalGraphBuilderValue,
  parseGraphBuilderDecision,
  parseGraphBuilderReadResult,
  parseGraphValidationResult,
  toBoundedGraphBuilderIdentifier,
  type ApplyPatchResult,
  type GraphBuilderDecision,
  type GraphBuilderProjection,
  type GraphBuilderReadRequest,
  type GraphBuilderReadResult,
  type GraphBuilderSessionResult,
  type GraphDiagnostic,
  type GraphDraftDelta,
  type GraphPatch,
  type GraphPatchProposal,
  type GraphValidationResult,
} from '../../domain/graphBuilder/index.js';
import type { GraphBuilderCommitOutcome } from './editorGateway.js';
import type { GraphBuilderBaseIdentity } from './identity.js';

type AuthoringProject = Omit<Project, 'data'>;

export type GraphBuilderPolicyUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  completeness: 'complete' | 'partial' | 'unavailable';
};

export type GraphBuilderPolicyTurn = {
  protocolVersion: number;
  policyVersion: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  phase: 'gathering-context' | 'editing' | 'repairing';
  userRequest: string;
  draftRevision: number;
  projection: GraphBuilderProjection;
  transcript: GraphBuilderTranscriptItem[];
  contextResults: GraphBuilderReadResult[];
  diagnostics: GraphDiagnostic[];
  remainingBudget: GraphBuilderRemainingBudget;
  contextMode: 'full' | 'compacted';
};

export type GraphBuilderPolicyExecutionResult = {
  protocolVersion: number;
  policyVersion: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  decision: GraphBuilderDecision;
  usage: GraphBuilderPolicyUsage;
};

export type GraphBuilderFullTranscriptItem =
  | {
      type: 'decision';
      turnId: string;
      draftRevision: number;
      decision: GraphBuilderDecision;
    }
  | {
      type: 'read-result';
      turnId: string;
      draftRevision: number;
      result: GraphBuilderReadResult;
    }
  | {
      type: 'patch-result';
      turnId: string;
      draftRevision: number;
      result: ApplyPatchResult;
    }
  | {
      type: 'clarification-answer';
      turnId: string;
      draftRevision: number;
      answer: string;
    };

export type GraphBuilderCompactedTranscriptItem = {
  type: 'compacted';
  originalType: GraphBuilderFullTranscriptItem['type'];
  turnId: string;
  draftRevision: number;
  digest: string;
  summary: string;
};

export type GraphBuilderTranscriptItem = GraphBuilderFullTranscriptItem | GraphBuilderCompactedTranscriptItem;

export type GraphBuilderRemainingBudget = {
  policyAttempts: number;
  repairAttempts: number;
  milliseconds: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type GraphBuilderSessionLimits = {
  maxPolicyAttempts: number;
  maxRepairAttempts: number;
  maxWallTimeMs: number;
  maxInactivityMs: number;
  maxTranscriptBytes: number;
  maxPolicyTurnBytes: number;
  clarificationTtlMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
};

export const DEFAULT_GRAPH_BUILDER_SESSION_LIMITS: GraphBuilderSessionLimits = {
  maxPolicyAttempts: 16,
  maxRepairAttempts: 4,
  maxWallTimeMs: 5 * 60_000,
  maxInactivityMs: 2 * 60_000,
  maxTranscriptBytes: 96 * 1024,
  maxPolicyTurnBytes: 256_000,
  clarificationTtlMs: 10 * 60_000,
  maxInputTokens: 500_000,
  maxOutputTokens: 100_000,
  maxCostUsd: 25,
};

export type GraphBuilderPreview = {
  delta: GraphDraftDelta;
  diagnostics: GraphDiagnostic[];
  draftRevision: number;
  summary: string;
};

export type GraphBuilderSessionViewState =
  | { status: 'created'; sessionId: string }
  | {
      status: 'gathering-context' | 'editing' | 'repairing';
      sessionId: string;
      policyAttempts: number;
      progress: string;
    }
  | {
      status: 'awaiting-user';
      sessionId: string;
      question: string;
      resumeToken: string;
      expiresAt: number;
    }
  | {
      status: 'ready-for-preview';
      sessionId: string;
      preview: GraphBuilderPreview;
    }
  | { status: 'committing'; sessionId: string; preview: GraphBuilderPreview }
  | {
      status:
        | 'committed'
        | 'no-change'
        | 'cannot-complete'
        | 'discarded'
        | 'canceled'
        | 'failed'
        | 'budget-exhausted'
        | 'conflicted'
        | 'expired';
      sessionId: string;
      result: GraphBuilderSessionResult;
      retainedPreview?: GraphBuilderPreview;
    };

export type GraphBuilderTerminalViewState = Extract<
  GraphBuilderSessionViewState,
  { result: GraphBuilderSessionResult }
>;

export function isGraphBuilderTerminalViewState(
  state: GraphBuilderSessionViewState,
): state is GraphBuilderTerminalViewState {
  return 'result' in state;
}

export const GRAPH_BUILDER_METRICS_VERSION = 1 as const;

export type GraphBuilderMetricsEvent = {
  protocolVersion: typeof GRAPH_BUILDER_METRICS_VERSION;
  outcome: GraphBuilderSessionResult['status'];
  failureCode?: string;
  durationMs: number;
  policyAttempts: number;
  repairAttempts: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  usageCompleteness: 'complete' | 'partial' | 'unavailable';
};

export interface GraphBuilderMetricsSink {
  record(event: GraphBuilderMetricsEvent): void;
}

export const NOOP_GRAPH_BUILDER_METRICS_SINK: GraphBuilderMetricsSink = Object.freeze({
  record() {
    // Deliberately empty. Products may inject a privacy-reviewed local sink.
  },
});

export type GraphBuilderSessionControllerOptions = {
  base: GraphBuilderBaseIdentity;
  buildProjection(input: {
    delta: GraphDraftDelta;
    diagnostics: GraphDiagnostic[];
    draft: AuthoringProject;
    draftRevision: number;
  }): GraphBuilderProjection;
  commit(input: { draft: AuthoringProject; draftRevision: number; summary: string }): GraphBuilderCommitOutcome;
  executePolicy(turn: GraphBuilderPolicyTurn, abortSignal: AbortSignal): Promise<GraphBuilderPolicyExecutionResult>;
  kernel: {
    applyPatch(patch: GraphPatch): ApplyPatchResult;
    getDraft(): AuthoringProject;
    getDraftDelta(): GraphDraftDelta;
    getDraftRevision(): number;
    hasDraftChanges(): boolean;
  };
  limits?: Partial<GraphBuilderSessionLimits>;
  metricsSink?: GraphBuilderMetricsSink;
  policyVersion: string;
  read(
    request: GraphBuilderReadRequest,
    context: {
      requestId: string;
      requestIndex: number;
      observedDraftRevision: number;
      draft: AuthoringProject;
      abortSignal: AbortSignal;
    },
  ): Promise<GraphBuilderReadResult>;
  request: string;
  sessionId?: string;
  validateDraft(draft: AuthoringProject): GraphValidationResult;
  verifyIdentity(): {
    matches: boolean;
    currentFingerprint: string;
  };
};

type ClarificationState = {
  answer?: string;
  expiresAt: number;
  question: string;
  resumeToken: string;
  turnId: string;
};

export class GraphBuilderSessionController {
  readonly #options: GraphBuilderSessionControllerOptions;
  readonly #limits: GraphBuilderSessionLimits;
  readonly #request: string;
  readonly #sessionId: string;
  readonly #startedAt = Date.now();
  readonly #hardDeadlineAt: number;
  readonly #abortController = new AbortController();
  readonly #listeners = new Set<(state: GraphBuilderSessionViewState) => void>();
  readonly #turnPatchLedger = new Map<string, GraphPatch>();
  readonly #usedResumeTokens = new Map<string, string>();
  readonly #usage: GraphBuilderPolicyUsage[] = [];
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  #clarificationTimer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #state: GraphBuilderSessionViewState;
  #terminal = false;
  #policyAttempts = 0;
  #repairAttempts = 0;
  #turnSequence = 0;
  #transcript: GraphBuilderTranscriptItem[] = [];
  #contextResults: GraphBuilderReadResult[] = [];
  #diagnostics: GraphDiagnostic[] = [];
  #lastSummary: string | undefined;
  #clarification: ClarificationState | undefined;

  constructor(options: GraphBuilderSessionControllerOptions) {
    this.#options = options;
    this.#limits = validateSessionLimits({
      ...DEFAULT_GRAPH_BUILDER_SESSION_LIMITS,
      ...options.limits,
    });
    this.#hardDeadlineAt = this.#startedAt + this.#limits.maxWallTimeMs;
    this.#request = options.request.trim();
    const sessionId = options.sessionId ?? newId();
    if (
      typeof sessionId !== 'string' ||
      sessionId.length === 0 ||
      sessionId.length > GRAPH_BUILDER_LIMITS.maxIdentifierLength ||
      sessionId.trim() !== sessionId
    ) {
      throw new Error(
        `Graph Builder session IDs must contain between 1 and ${GRAPH_BUILDER_LIMITS.maxIdentifierLength.toString(10)} characters without surrounding whitespace.`,
      );
    }
    this.#sessionId = sessionId;
    this.#state = { status: 'created', sessionId: this.#sessionId };
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  getState(): GraphBuilderSessionViewState {
    return cloneDeep(this.#state);
  }

  subscribe(listener: (state: GraphBuilderSessionViewState) => void): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.getState());
    } catch {
      // UI observers do not own the session, including the initial snapshot.
    }
    return () => this.#listeners.delete(listener);
  }

  start(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state.status !== 'created') {
        return;
      }
      if (!this.#request) {
        this.#fail('invalid-request', 'Enter a graph-building request.');
        return;
      }
      if (this.#request.length > GRAPH_BUILDER_LIMITS.maxStringLength) {
        this.#fail(
          'invalid-request',
          `Graph-building requests are limited to ${GRAPH_BUILDER_LIMITS.maxStringLength.toString(10)} characters.`,
        );
        return;
      }
      if (!this.#recheckIdentity()) {
        return;
      }
      this.#startDeadlineTimer();
      this.#touchInactivityTimer();
      await this.#runPolicyLoop('gathering-context');
    });
  }

  resume(resumeToken: string, answer: string): Promise<void> {
    return this.#enqueue(async () => {
      const clarification = this.#clarification;
      const trimmedAnswer = answer.trim();
      const previousAnswer = this.#usedResumeTokens.get(resumeToken);
      if (previousAnswer !== undefined) {
        if (previousAnswer === trimmedAnswer) {
          return;
        }
        this.#fail('invalid-resume', 'A clarification token was reused with different content.');
        return;
      }
      if (this.#state.status !== 'awaiting-user' || !clarification || clarification.resumeToken !== resumeToken) {
        this.#fail('invalid-resume', 'This clarification request is no longer active.');
        return;
      }
      if (Date.now() >= clarification.expiresAt) {
        this.#expire();
        return;
      }
      if (!trimmedAnswer) {
        this.#fail('invalid-resume', 'A clarification answer is required.');
        return;
      }
      if (trimmedAnswer.length > GRAPH_BUILDER_LIMITS.maxStringLength) {
        this.#fail(
          'invalid-resume',
          `Clarification answers are limited to ${GRAPH_BUILDER_LIMITS.maxStringLength.toString(10)} characters.`,
        );
        return;
      }
      if (clarification.answer !== undefined) {
        if (clarification.answer === trimmedAnswer) {
          return;
        }
        this.#fail('invalid-resume', 'A clarification token was reused with different content.');
        return;
      }
      clarification.answer = trimmedAnswer;
      this.#clearClarificationTimer();
      this.#usedResumeTokens.set(resumeToken, trimmedAnswer);
      this.#transcript.push({
        type: 'clarification-answer',
        turnId: clarification.turnId,
        draftRevision: this.#options.kernel.getDraftRevision(),
        answer: trimmedAnswer,
      });
      this.#clarification = undefined;
      if (!this.#recheckIdentity()) {
        return;
      }
      this.#touchInactivityTimer();
      await this.#runPolicyLoop('editing');
    });
  }

  apply(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state.status !== 'ready-for-preview') {
        return;
      }
      const preview = this.#state.preview;
      if (!this.#checkHardDeadline()) {
        return;
      }
      if (!this.#recheckIdentity(preview)) {
        return;
      }
      this.#setState({ status: 'committing', sessionId: this.#sessionId, preview });
      let outcome: GraphBuilderCommitOutcome;
      try {
        outcome = this.#options.commit({
          draft: this.#options.kernel.getDraft(),
          draftRevision: this.#options.kernel.getDraftRevision(),
          summary: preview.summary,
        });
      } catch (error) {
        this.#fail('commit-failed', 'Rivet could not publish the prepared graph change.', preview, error);
        return;
      }
      if (outcome.status === 'committed') {
        this.#terminate({
          status: 'committed',
          base: toPortableBaseIdentity(this.#options.base),
          draftRevision: outcome.draftRevision,
          summary: outcome.summary,
        });
      } else if (outcome.status === 'conflicted') {
        this.#terminate(
          {
            status: 'conflicted',
            base: toPortableBaseIdentity(this.#options.base),
            currentFingerprint: outcome.currentFingerprint,
          },
          preview,
        );
      } else if (outcome.status === 'ineligible') {
        this.#fail('commit-ineligible', outcome.reason, preview);
      } else {
        this.#fail('commit-protocol-error', outcome.reason, preview);
      }
    });
  }

  discard(): Promise<void> {
    if (this.#terminal || this.#state.status === 'committing') {
      return Promise.resolve();
    }
    this.#abortController.abort('Graph Builder draft discarded');
    this.#terminate({
      status: 'discarded',
      ...(this.#lastSummary ? { summary: this.#lastSummary } : {}),
    });
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    if (this.#terminal || this.#state.status === 'committing') {
      return Promise.resolve();
    }
    this.#abortController.abort('Graph Builder canceled');
    this.#terminate({ status: 'canceled' });
    return Promise.resolve();
  }

  async #runPolicyLoop(initialPhase: 'gathering-context' | 'editing' | 'repairing'): Promise<void> {
    let phase = initialPhase;

    while (!this.#terminal && !this.#abortController.signal.aborted) {
      if (!this.#checkHardLimits()) {
        return;
      }
      if (!this.#recheckIdentity()) {
        return;
      }

      const nextPolicyAttempt = this.#policyAttempts + 1;
      const nextTurnSequence = this.#turnSequence + 1;
      const turnId = toBoundedGraphBuilderIdentifier(`${this.#sessionId}:turn:${nextTurnSequence}`);
      const attemptId = toBoundedGraphBuilderIdentifier(`${turnId}:attempt:${nextPolicyAttempt}`);
      const draftRevision = this.#options.kernel.getDraftRevision();
      let projection: GraphBuilderProjection;
      try {
        projection = this.#options.buildProjection({
          delta: this.#options.kernel.getDraftDelta(),
          diagnostics: this.#diagnostics,
          draft: this.#options.kernel.getDraft(),
          draftRevision,
        });
      } catch (error) {
        this.#fail('projection-failed', 'Graph Builder could not safely project the current draft.', undefined, error);
        return;
      }
      const compacted = compactTranscript(this.#transcript, this.#limits.maxTranscriptBytes);
      if (compacted.overLimit) {
        this.#terminate({
          status: 'budget-exhausted',
          diagnostics: this.#diagnostics,
        });
        return;
      }
      const turn: GraphBuilderPolicyTurn = {
        protocolVersion: GRAPH_BUILDER_PROTOCOL_VERSION,
        policyVersion: this.#options.policyVersion,
        sessionId: this.#sessionId,
        turnId,
        attemptId,
        phase,
        userRequest: this.#request,
        draftRevision,
        projection,
        transcript: compacted.items,
        contextResults: this.#contextResults,
        diagnostics: this.#diagnostics,
        remainingBudget: this.#remainingBudget(nextPolicyAttempt),
        contextMode: compacted.compacted ? 'compacted' : 'full',
      };
      if (portableByteLength(turn) > this.#limits.maxPolicyTurnBytes) {
        this.#terminate({
          status: 'budget-exhausted',
          diagnostics: this.#diagnostics,
        });
        return;
      }
      // Projection, transcript compaction, and canonical byte measurement are
      // synchronous. Recheck the wall clock before reserving a physical call
      // because a timer cannot fire while those operations own the event loop.
      if (!this.#checkHardDeadline()) {
        return;
      }
      this.#policyAttempts = nextPolicyAttempt;
      this.#turnSequence = nextTurnSequence;
      this.#setState({
        status: phase,
        sessionId: this.#sessionId,
        policyAttempts: this.#policyAttempts,
        progress: progressForPhase(phase),
      });

      let execution: GraphBuilderPolicyExecutionResult;
      try {
        execution = await waitForAbort(
          this.#options.executePolicy(turn, this.#abortController.signal),
          this.#abortController.signal,
        );
      } catch (error) {
        if (error instanceof GraphBuilderSessionWaitAbortedError && this.#terminal) {
          return;
        }
        this.#usage.push(getPolicyUsageFromError(error) ?? { completeness: 'unavailable' });
        if (this.#terminal) {
          return;
        }
        if (this.#abortController.signal.aborted) {
          this.#terminate({ status: 'canceled' });
          return;
        }
        if (this.#usageBudgetExceeded()) {
          this.#terminate({
            status: 'budget-exhausted',
            diagnostics: this.#diagnostics,
          });
          return;
        }
        if (!this.#checkHardDeadline()) {
          return;
        }
        if (isRepairablePolicyExecutionError(error)) {
          this.#repairAttempts += 1;
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'invalid-policy-decision',
            'The provider response did not match the Graph Builder decision contract.',
          );
          if (this.#repairAttempts > this.#limits.maxRepairAttempts) {
            this.#terminate({
              status: 'budget-exhausted',
              diagnostics: this.#diagnostics,
            });
            return;
          }
          phase = 'repairing';
          this.#touchInactivityTimer();
          continue;
        }
        this.#fail(
          'policy-failed',
          'The selected AI provider could not produce a Graph Builder decision.',
          undefined,
          error,
        );
        return;
      }

      this.#touchInactivityTimer();
      const usage = parsePolicyUsage(safelyReadProperty(execution, 'usage'));
      this.#usage.push(usage ?? { completeness: 'unavailable' });
      if (this.#terminal) {
        return;
      }
      if (this.#abortController.signal.aborted) {
        this.#terminate({ status: 'canceled' });
        return;
      }
      if (!usage) {
        this.#fail('invalid-policy-usage', 'The AI provider returned invalid Graph Builder accounting data.');
        return;
      }
      if (this.#usageBudgetExceeded()) {
        this.#terminate({
          status: 'budget-exhausted',
          diagnostics: this.#diagnostics,
        });
        return;
      }
      if (!this.#checkHardDeadline()) {
        return;
      }
      if (!this.#acceptExecutionCorrelation(execution, turn)) {
        return;
      }
      if (!this.#recheckIdentity()) {
        return;
      }
      let decision: GraphBuilderDecision;
      try {
        decision = parseGraphBuilderDecision(safelyReadProperty(execution, 'decision'));
      } catch (error) {
        this.#repairAttempts += 1;
        this.#recordPolicyRepairDiagnostic(
          turnId,
          'invalid-policy-decision',
          'The provider response did not match the Graph Builder decision contract.',
        );
        if (this.#repairAttempts > this.#limits.maxRepairAttempts) {
          this.#terminate({
            status: 'budget-exhausted',
            diagnostics: this.#diagnostics,
          });
          return;
        }
        phase = 'repairing';
        continue;
      }
      this.#transcript.push({ type: 'decision', turnId, draftRevision, decision });

      if (decision.type === 'request-context') {
        const results = await this.#executeReadBatch(decision.requests, turnId, draftRevision);
        if (!results) {
          return;
        }
        this.#contextResults = results;
        phase = 'gathering-context';
        continue;
      }

      if (decision.type === 'propose-patch') {
        let patch: GraphPatch;
        try {
          patch = this.#getOrCreatePatch(turnId, draftRevision, decision.proposal);
        } catch (error) {
          this.#fail('patch-identity-error', 'The policy reused a patch identity inconsistently.', undefined, error);
          return;
        }
        let result: ApplyPatchResult;
        try {
          result = this.#options.kernel.applyPatch(patch);
        } catch (error) {
          this.#fail('patch-protocol-error', 'The proposed graph patch was invalid.', undefined, error);
          return;
        }
        const resultRevision = result.disposition === 'replayed' ? result.original.draftRevision : result.draftRevision;
        this.#transcript.push({
          type: 'patch-result',
          turnId,
          draftRevision: resultRevision,
          result,
        });
        const freshResult = result.disposition === 'replayed' ? result.original : result;
        this.#diagnostics = freshResult.diagnostics;

        if (freshResult.disposition === 'rejected') {
          this.#repairAttempts += 1;
          if (this.#repairAttempts > this.#limits.maxRepairAttempts) {
            this.#terminate({
              status: 'budget-exhausted',
              diagnostics: this.#diagnostics,
            });
            return;
          }
          phase = 'repairing';
          continue;
        }

        this.#lastSummary = decision.summary?.trim() || deterministicSummary(this.#options.kernel.getDraftDelta());
        this.#contextResults = [];

        if (decision.afterApply === 'ready-for-preview') {
          if (!this.#options.kernel.hasDraftChanges()) {
            this.#repairAttempts += 1;
            this.#recordPolicyRepairDiagnostic(
              turnId,
              'ready-without-draft-changes',
              'The policy requested preview, but the accepted draft matches the captured base.',
            );
            phase = 'repairing';
            continue;
          }
          if (this.#tryEnterPreview(this.#lastSummary)) {
            return;
          }
          phase = 'repairing';
          continue;
        }

        phase = 'editing';
        continue;
      }

      if (decision.type === 'ready') {
        if (!this.#options.kernel.hasDraftChanges()) {
          this.#repairAttempts += 1;
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'ready-without-draft-changes',
            'The policy reported readiness, but the accepted draft matches the captured base.',
          );
          phase = 'repairing';
          continue;
        }
        if (this.#tryEnterPreview(decision.summary)) {
          return;
        }
        phase = 'repairing';
        continue;
      }

      if (decision.type === 'no-change') {
        if (this.#options.kernel.hasDraftChanges()) {
          this.#repairAttempts += 1;
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'no-change-with-draft-changes',
            'The policy reported no change while the private draft still differs from the captured base.',
          );
          phase = 'repairing';
          continue;
        }
        if (!this.#checkHardDeadline()) {
          return;
        }
        this.#terminate({
          status: 'no-change',
          base: toPortableBaseIdentity(this.#options.base),
          summary: decision.summary,
        });
        return;
      }

      if (decision.type === 'clarify') {
        if (!this.#checkHardDeadline()) {
          return;
        }
        if (!this.#recheckIdentity()) {
          return;
        }
        const resumeToken = newId();
        const expiresAt = Math.min(Date.now() + this.#limits.clarificationTtlMs, this.#hardDeadlineAt);
        this.#clarification = {
          expiresAt,
          question: decision.question,
          resumeToken,
          turnId,
        };
        this.#clearInactivityTimer();
        this.#startClarificationTimer(expiresAt);
        this.#setState({
          status: 'awaiting-user',
          sessionId: this.#sessionId,
          question: decision.question,
          resumeToken,
          expiresAt,
        });
        return;
      }

      if (!this.#checkHardDeadline()) {
        return;
      }
      this.#terminate({
        status: 'cannot-complete',
        code: decision.reasonCode,
        reason: decision.reason,
      });
      return;
    }

    if (!this.#terminal) {
      this.#terminate({ status: 'canceled' });
    }
  }

  async #executeReadBatch(
    requests: GraphBuilderReadRequest[],
    turnId: string,
    draftRevision: number,
  ): Promise<GraphBuilderReadResult[] | undefined> {
    const batchAbort = new AbortController();
    const abortFromSession = () => batchAbort.abort(this.#abortController.signal.reason);
    this.#abortController.signal.addEventListener('abort', abortFromSession, { once: true });
    const draft = this.#options.kernel.getDraft();

    try {
      const promises = requests.map(async (request, requestIndex) => {
        const requestId = createReadRequestId(turnId, requestIndex);
        try {
          const rawResult = await waitForAbort(
            this.#options.read(request, {
              requestId,
              requestIndex,
              observedDraftRevision: draftRevision,
              draft,
              abortSignal: batchAbort.signal,
            }),
            batchAbort.signal,
          );
          try {
            return {
              kind: 'result' as const,
              result: parseGraphBuilderReadResult(rawResult),
            };
          } catch {
            batchAbort.abort('A Graph Builder read returned an invalid result');
            return { kind: 'protocol-error' as const };
          }
        } catch {
          batchAbort.abort('A Graph Builder read failed');
          return {
            kind: 'result' as const,
            result: {
              requestId,
              requestIndex,
              observedDraftRevision: draftRevision,
              status: 'failed' as const,
              error: {
                code: 'read-failed',
                message: 'The requested Graph Builder context could not be read.',
              },
            },
          };
        }
      });
      const outcomes = await Promise.all(promises);
      this.#touchInactivityTimer();
      if (this.#abortController.signal.aborted) {
        this.#terminate({ status: 'canceled' });
        return undefined;
      }
      if (this.#terminal) {
        return undefined;
      }
      if (!this.#checkHardDeadline()) {
        return undefined;
      }
      if (!this.#recheckIdentity()) {
        return undefined;
      }
      if (outcomes.some((outcome) => outcome.kind === 'protocol-error')) {
        this.#fail('invalid-read-result', 'Graph Builder received an invalid context result.');
        return undefined;
      }
      const results = outcomes.flatMap((outcome) => (outcome.kind === 'result' ? [outcome.result] : []));
      for (const [requestIndex, result] of results.entries()) {
        const expectedRequestId = createReadRequestId(turnId, requestIndex);
        if (
          result.observedDraftRevision !== draftRevision ||
          result.requestIndex !== requestIndex ||
          result.requestId !== expectedRequestId
        ) {
          this.#fail('mismatched-read-result', 'Graph Builder received an incorrectly correlated context result.');
          return undefined;
        }
        this.#transcript.push({
          type: 'read-result',
          turnId,
          draftRevision,
          result,
        });
      }
      return results;
    } finally {
      this.#abortController.signal.removeEventListener('abort', abortFromSession);
    }
  }

  #getOrCreatePatch(turnId: string, draftRevision: number, proposal: GraphPatchProposal): GraphPatch {
    const previous = this.#turnPatchLedger.get(turnId);
    if (previous) {
      if (
        canonicalGraphBuilderStringify({
          protocolVersion: previous.protocolVersion,
          operations: previous.operations,
        }) !== canonicalGraphBuilderStringify(proposal)
      ) {
        throw new Error('A policy turn reused its identity with different patch content.');
      }
      return previous;
    }

    const patch: GraphPatch = {
      ...proposal,
      patchId: toBoundedGraphBuilderIdentifier(`${turnId}:patch`),
      expectedDraftRevision: draftRevision,
    };
    this.#turnPatchLedger.set(turnId, patch);
    return patch;
  }

  #tryEnterPreview(summary: string): boolean {
    if (!this.#recheckIdentity()) {
      return true;
    }
    const draft = this.#options.kernel.getDraft();
    let validation: GraphValidationResult;
    try {
      validation = parseGraphValidationResult(this.#options.validateDraft(draft));
    } catch (error) {
      this.#fail('validation-failed', 'Graph Builder could not validate the prepared draft.', undefined, error);
      return true;
    }
    this.#diagnostics = validation.diagnostics;
    if (!this.#checkHardDeadline()) {
      return true;
    }
    if (validation.completeness !== 'complete' || validation.blockingDiagnosticKeys.length > 0) {
      this.#repairAttempts += 1;
      return false;
    }
    const delta = this.#options.kernel.getDraftDelta();
    const preview: GraphBuilderPreview = {
      delta,
      diagnostics: this.#diagnostics,
      draftRevision: this.#options.kernel.getDraftRevision(),
      summary: summary.trim() || deterministicSummary(delta),
    };
    if (!this.#checkHardDeadline()) {
      return true;
    }
    // Inactivity protects active provider/read work. Once a preview is ready,
    // the controller is waiting on the user; only the hard session deadline
    // should bound review time.
    this.#clearInactivityTimer();
    this.#setState({ status: 'ready-for-preview', sessionId: this.#sessionId, preview });
    return true;
  }

  #acceptExecutionCorrelation(execution: GraphBuilderPolicyExecutionResult, turn: GraphBuilderPolicyTurn): boolean {
    if (
      safelyReadProperty(execution, 'protocolVersion') !== GRAPH_BUILDER_PROTOCOL_VERSION ||
      safelyReadProperty(execution, 'policyVersion') !== turn.policyVersion ||
      safelyReadProperty(execution, 'sessionId') !== this.#sessionId ||
      safelyReadProperty(execution, 'turnId') !== turn.turnId ||
      safelyReadProperty(execution, 'attemptId') !== turn.attemptId
    ) {
      this.#fail('stale-policy-result', 'Graph Builder received a stale or mismatched policy result.');
      return false;
    }
    return true;
  }

  #recheckIdentity(retainedPreview?: GraphBuilderPreview): boolean {
    let identity: ReturnType<GraphBuilderSessionControllerOptions['verifyIdentity']>;
    try {
      identity = this.#options.verifyIdentity();
    } catch (error) {
      this.#fail(
        'identity-check-failed',
        'Rivet could not verify that the project is unchanged.',
        retainedPreview,
        error,
      );
      return false;
    }
    if (identity.matches) {
      return true;
    }
    this.#terminate(
      {
        status: 'conflicted',
        base: toPortableBaseIdentity(this.#options.base),
        currentFingerprint: identity.currentFingerprint,
      },
      retainedPreview,
    );
    return false;
  }

  #checkHardLimits(): boolean {
    if (!this.#checkHardDeadline()) {
      return false;
    }
    if (this.#policyAttempts >= this.#limits.maxPolicyAttempts) {
      this.#terminate({
        status: 'budget-exhausted',
        diagnostics: this.#diagnostics,
      });
      return false;
    }
    if (this.#repairAttempts > this.#limits.maxRepairAttempts) {
      this.#terminate({
        status: 'budget-exhausted',
        diagnostics: this.#diagnostics,
      });
      return false;
    }
    if (this.#usageBudgetExhaustedBeforeCall()) {
      this.#terminate({
        status: 'budget-exhausted',
        diagnostics: this.#diagnostics,
      });
      return false;
    }
    return true;
  }

  #checkHardDeadline(): boolean {
    if (Date.now() >= this.#hardDeadlineAt) {
      this.#expire();
      return false;
    }
    return true;
  }

  #remainingBudget(policyAttempts = this.#policyAttempts): GraphBuilderRemainingBudget {
    const totals = this.#usageTotals();
    return {
      policyAttempts: Math.max(0, this.#limits.maxPolicyAttempts - policyAttempts),
      repairAttempts: Math.max(0, this.#limits.maxRepairAttempts - this.#repairAttempts),
      milliseconds: Math.max(0, this.#limits.maxWallTimeMs - this.#elapsedMs()),
      inputTokens: Math.max(0, this.#limits.maxInputTokens - (totals.inputTokens ?? 0)),
      outputTokens: Math.max(0, this.#limits.maxOutputTokens - (totals.outputTokens ?? 0)),
      costUsd: Math.max(0, this.#limits.maxCostUsd - (totals.costUsd ?? 0)),
    };
  }

  #usageTotals(): {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  } {
    const total = (field: 'inputTokens' | 'outputTokens' | 'costUsd') => {
      const values = this.#usage.flatMap((usage) => (usage[field] === undefined ? [] : [usage[field]]));
      return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
    };
    return {
      inputTokens: total('inputTokens'),
      outputTokens: total('outputTokens'),
      costUsd: total('costUsd'),
    };
  }

  #usageBudgetExceeded(): boolean {
    const totals = this.#usageTotals();
    return (
      (totals.inputTokens !== undefined && totals.inputTokens > this.#limits.maxInputTokens) ||
      (totals.outputTokens !== undefined && totals.outputTokens > this.#limits.maxOutputTokens) ||
      (totals.costUsd !== undefined && totals.costUsd > this.#limits.maxCostUsd)
    );
  }

  #usageBudgetExhaustedBeforeCall(): boolean {
    const totals = this.#usageTotals();
    const exhausted = (total: number | undefined, limit: number) =>
      limit === 0 || (total !== undefined && total >= limit);
    return (
      exhausted(totals.inputTokens, this.#limits.maxInputTokens) ||
      exhausted(totals.outputTokens, this.#limits.maxOutputTokens) ||
      exhausted(totals.costUsd, this.#limits.maxCostUsd)
    );
  }

  #startDeadlineTimer(): void {
    if (this.#deadlineTimer || this.#terminal) {
      return;
    }
    this.#deadlineTimer = setTimeout(
      () => {
        this.#expire();
      },
      Math.max(0, this.#hardDeadlineAt - Date.now()),
    );
    unrefTimer(this.#deadlineTimer);
  }

  #touchInactivityTimer(): void {
    if (
      this.#terminal ||
      this.#state.status === 'awaiting-user' ||
      this.#state.status === 'ready-for-preview' ||
      this.#state.status === 'committing'
    ) {
      return;
    }
    this.#clearInactivityTimer();
    this.#inactivityTimer = setTimeout(() => {
      this.#expire();
    }, this.#limits.maxInactivityMs);
    unrefTimer(this.#inactivityTimer);
  }

  #clearInactivityTimer(): void {
    if (this.#inactivityTimer) {
      clearTimeout(this.#inactivityTimer);
      this.#inactivityTimer = undefined;
    }
  }

  #startClarificationTimer(expiresAt: number): void {
    this.#clearClarificationTimer();
    this.#clarificationTimer = setTimeout(
      () => {
        if (!this.#terminal && this.#state.status === 'awaiting-user') {
          this.#expire();
        }
      },
      Math.max(0, expiresAt - Date.now()),
    );
    unrefTimer(this.#clarificationTimer);
  }

  #clearClarificationTimer(): void {
    if (this.#clarificationTimer) {
      clearTimeout(this.#clarificationTimer);
      this.#clarificationTimer = undefined;
    }
  }

  #expire(): void {
    this.#abortController.abort('Graph Builder session expired');
    this.#terminate({ status: 'expired' });
  }

  #fail(code: string, userMessage: string, retainedPreview?: GraphBuilderPreview, rawError?: unknown): void {
    this.#terminate(
      {
        status: 'failed',
        failure: {
          code,
          userMessage,
          ...(rawError instanceof Error ? { developerMessage: rawError.name } : {}),
        },
        diagnostics: this.#diagnostics,
      },
      retainedPreview,
    );
  }

  #terminate(result: GraphBuilderSessionResult, retainedPreview?: GraphBuilderPreview): void {
    if (this.#terminal) {
      return;
    }
    this.#terminal = true;
    if (this.#deadlineTimer) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
    this.#clearInactivityTimer();
    this.#clearClarificationTimer();
    if (!this.#abortController.signal.aborted && result.status !== 'committed') {
      this.#abortController.abort(`Graph Builder terminal state: ${result.status}`);
    }
    this.#setState({
      status: result.status,
      sessionId: this.#sessionId,
      result,
      ...(retainedPreview ? { retainedPreview } : {}),
    } as GraphBuilderSessionViewState);
    this.#emitMetrics(result);
  }

  #emitMetrics(result: GraphBuilderSessionResult): void {
    const completeness = combineUsageCompleteness(this.#usage);
    const totals = this.#usageTotals();
    try {
      (this.#options.metricsSink ?? NOOP_GRAPH_BUILDER_METRICS_SINK).record({
        protocolVersion: GRAPH_BUILDER_METRICS_VERSION,
        outcome: result.status,
        ...(result.status === 'failed' ? { failureCode: result.failure.code } : {}),
        durationMs: this.#elapsedMs(),
        policyAttempts: this.#policyAttempts,
        repairAttempts: this.#repairAttempts,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costUsd: totals.costUsd,
        usageCompleteness: completeness,
      });
    } catch {
      // Metrics are optional and must never affect a session outcome.
    }
  }

  #elapsedMs(): number {
    return Math.max(0, Date.now() - this.#startedAt);
  }

  #recordPolicyRepairDiagnostic(turnId: string, ruleId: string, message: string): void {
    const diagnostic: GraphDiagnostic = {
      diagnosticKey: toBoundedGraphBuilderIdentifier(`policy-repair:${turnId}`),
      ruleId,
      rulesVersion: this.#options.base.validationRulesVersion,
      severity: 'error',
      verification: 'verified',
      message,
    };
    this.#diagnostics = [
      ...this.#diagnostics.filter((entry) => entry.diagnosticKey !== diagnostic.diagnosticKey),
      diagnostic,
    ].slice(-GRAPH_BUILDER_LIMITS.maxDiagnostics);
  }

  #setState(state: GraphBuilderSessionViewState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      try {
        listener(this.getState());
      } catch {
        // UI observers do not own the session.
      }
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const guardedOperation = async () => {
      try {
        await operation();
      } catch (error) {
        if (!this.#terminal) {
          this.#fail(
            'controller-failed',
            'Graph Builder stopped because of an internal controller error.',
            undefined,
            error,
          );
        }
      }
    };
    const scheduled = this.#queue.then(guardedOperation, guardedOperation);
    this.#queue = scheduled.catch(() => undefined);
    return scheduled;
  }
}

function compactTranscript(
  transcript: GraphBuilderTranscriptItem[],
  maxBytes: number,
): {
  compacted: boolean;
  items: GraphBuilderTranscriptItem[];
  overLimit: boolean;
} {
  if (portableByteLength(transcript) <= maxBytes) {
    return { compacted: false, items: cloneDeep(transcript), overLimit: false };
  }

  const compactedItems = transcript.map(compactTranscriptItem);
  if (portableByteLength(compactedItems) > maxBytes) {
    return { compacted: true, items: [], overLimit: true };
  }

  // Preserve as many recent full bodies as fit, while retaining a stable
  // identity/digest entry for every older turn. This never evicts dedupe
  // evidence merely to make the next provider request fit.
  const retained = [...compactedItems];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const candidate = [...retained];
    candidate[index] = transcript[index]!;
    if (portableByteLength(candidate) <= maxBytes) {
      retained[index] = transcript[index]!;
    }
  }
  return { compacted: true, items: cloneDeep(retained), overLimit: false };
}

function compactTranscriptItem(item: GraphBuilderTranscriptItem): GraphBuilderTranscriptItem {
  if (item.type === 'compacted' || item.type === 'clarification-answer') {
    return cloneDeep(item);
  }
  return {
    type: 'compacted',
    originalType: item.type,
    turnId: item.turnId,
    draftRevision: item.draftRevision,
    digest: hashCanonicalGraphBuilderValue(item),
    summary: transcriptItemSummary(item),
  };
}

function transcriptItemSummary(item: GraphBuilderFullTranscriptItem): string {
  switch (item.type) {
    case 'decision':
      if (item.decision.type === 'request-context') {
        return `Decision requested ${item.decision.requests.length} context reads.`;
      }
      if (item.decision.type === 'propose-patch') {
        return `Decision proposed ${item.decision.proposal.operations.length} operations with ${item.decision.afterApply}.`;
      }
      return `Decision type: ${item.decision.type}.`;
    case 'read-result':
      return `Read ${item.result.requestId} completed with ${item.result.status}.`;
    case 'patch-result': {
      const result = item.result.disposition === 'replayed' ? item.result.original : item.result;
      return `Patch ${item.result.patchId} completed with ${result.disposition}.`;
    }
    case 'clarification-answer':
      return 'Clarification answer retained in full.';
  }
}

function portableByteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalGraphBuilderStringify(value)).byteLength;
}

function createReadRequestId(turnId: string, requestIndex: number): string {
  return toBoundedGraphBuilderIdentifier(`${turnId}:read:${requestIndex}`);
}

function deterministicSummary(delta: GraphDraftDelta | undefined): string {
  if (!delta) {
    return 'Prepared a validated graph change.';
  }
  const parts = [
    pluralize(delta.addedNodeCount ?? delta.addedNodes.length, 'node added', 'nodes added'),
    pluralize(delta.updatedNodeCount ?? delta.updatedNodes.length, 'node updated', 'nodes updated'),
    pluralize(delta.removedNodeCount ?? delta.removedNodes.length, 'node removed', 'nodes removed'),
    pluralize(delta.addedConnectionCount ?? delta.addedConnections.length, 'connection added', 'connections added'),
    pluralize(
      delta.removedConnectionCount ?? delta.removedConnections.length,
      'connection removed',
      'connections removed',
    ),
  ].filter((part) => !part.startsWith('0 '));
  return parts.length > 0 ? `Prepared ${parts.join(', ')}.` : 'Prepared a validated graph change.';
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function progressForPhase(phase: 'gathering-context' | 'editing' | 'repairing'): string {
  switch (phase) {
    case 'gathering-context':
      return 'Inspecting the available graph-building context…';
    case 'editing':
      return 'Preparing a private graph draft…';
    case 'repairing':
      return 'Repairing the private draft against Rivet validation…';
  }
}

function combineUsageCompleteness(usage: GraphBuilderPolicyUsage[]): 'complete' | 'partial' | 'unavailable' {
  if (usage.length === 0 || usage.every((entry) => entry.completeness === 'unavailable')) {
    return 'unavailable';
  }
  return usage.every((entry) => entry.completeness === 'complete') ? 'complete' : 'partial';
}

function getPolicyUsageFromError(error: unknown): GraphBuilderPolicyUsage | undefined {
  const usage = safelyReadProperty(error, 'usage');
  if (usage == null || typeof usage !== 'object') {
    return undefined;
  }
  return parsePolicyUsage(usage);
}

function isRepairablePolicyExecutionError(error: unknown): boolean {
  return safelyReadProperty(error, 'code') === 'invalid-decision';
}

function safelyReadProperty(value: unknown, property: string): unknown {
  if (value == null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function parsePolicyUsage(usageValue: unknown): GraphBuilderPolicyUsage | undefined {
  if (usageValue == null || typeof usageValue !== 'object') {
    return undefined;
  }
  const completeness = safelyReadProperty(usageValue, 'completeness');
  const inputTokens = safelyReadProperty(usageValue, 'inputTokens');
  const outputTokens = safelyReadProperty(usageValue, 'outputTokens');
  const costUsd = safelyReadProperty(usageValue, 'costUsd');
  if (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'unavailable') {
    return undefined;
  }
  const optionalTokenCount = (value: unknown) =>
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  const optionalCost = (value: unknown) =>
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER);
  if (!optionalTokenCount(inputTokens) || !optionalTokenCount(outputTokens) || !optionalCost(costUsd)) {
    return undefined;
  }
  const presentFieldCount = [inputTokens, outputTokens, costUsd].filter((value) => value !== undefined).length;
  if (
    (completeness === 'complete' && presentFieldCount !== 3) ||
    (completeness === 'partial' && (presentFieldCount === 0 || presentFieldCount === 3)) ||
    (completeness === 'unavailable' && presentFieldCount !== 0)
  ) {
    return undefined;
  }
  return {
    completeness,
    ...(inputTokens === undefined ? {} : { inputTokens: inputTokens as number }),
    ...(outputTokens === undefined ? {} : { outputTokens: outputTokens as number }),
    ...(costUsd === undefined ? {} : { costUsd: costUsd as number }),
  };
}

function validateSessionLimits(limits: GraphBuilderSessionLimits): GraphBuilderSessionLimits {
  const maximumTimerDelayMs = 2_147_483_647;
  const strictlyPositive = new Set<keyof GraphBuilderSessionLimits>([
    'maxPolicyAttempts',
    'maxWallTimeMs',
    'maxInactivityMs',
    'maxTranscriptBytes',
    'maxPolicyTurnBytes',
    'clarificationTtlMs',
  ]);
  for (const [name, value] of Object.entries(limits)) {
    const key = name as keyof GraphBuilderSessionLimits;
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (strictlyPositive.has(key) && value === 0) ||
      (name === 'maxCostUsd' ? value > Number.MAX_SAFE_INTEGER : !Number.isSafeInteger(value))
    ) {
      throw new Error(`Invalid Graph Builder session limit "${name}".`);
    }
  }
  for (const timerLimit of ['maxWallTimeMs', 'maxInactivityMs', 'clarificationTtlMs'] as const) {
    if (limits[timerLimit] > maximumTimerDelayMs) {
      throw new Error(`Graph Builder session limit "${timerLimit}" exceeds the supported timer range.`);
    }
  }
  if (limits.maxTranscriptBytes > limits.maxPolicyTurnBytes) {
    throw new Error('Graph Builder transcript limit cannot exceed the complete policy-turn limit.');
  }
  if (limits.maxPolicyTurnBytes > GRAPH_BUILDER_LIMITS.maxPortableBytes) {
    throw new Error('Graph Builder policy-turn limit cannot exceed the portable protocol payload limit.');
  }
  return { ...limits };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (
    timer as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    }
  ).unref?.();
}

class GraphBuilderSessionWaitAbortedError extends Error {
  constructor() {
    super('Graph Builder stopped waiting for canceled work.');
    this.name = 'GraphBuilderSessionWaitAbortedError';
  }
}

function waitForAbort<T>(pending: Promise<T>, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      abortSignal.removeEventListener('abort', onAbort);
      reject(new GraphBuilderSessionWaitAbortedError());
    };
    if (abortSignal.aborted) {
      reject(new GraphBuilderSessionWaitAbortedError());
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    // Attach both reactions even when the signal was already aborted. The
    // pending adapter was created before this helper was entered and may reject
    // later; consuming that settlement prevents an unhandled rejection.
    pending.then(
      (value) => {
        abortSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function toPortableBaseIdentity(base: GraphBuilderBaseIdentity) {
  return {
    projectId: base.projectId,
    activeGraphId: base.activeGraphId,
    editorRevision: base.editorRevision,
    projectFingerprint: base.projectFingerprint,
    registryContractFingerprint: base.registryContractFingerprint,
    referencedProjectsFingerprint: base.referencedProjectsFingerprint,
    policyConfigFingerprint: base.policyConfigFingerprint,
    validationRulesVersion: base.validationRulesVersion,
    protocolVersion: base.protocolVersion,
  };
}
