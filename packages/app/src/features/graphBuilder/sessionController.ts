import { type Project, newId } from '@valerypopoff/rivet2-core';
import { cloneDeep } from 'lodash-es';
import {
  GRAPH_BUILDER_LIMITS,
  GRAPH_BUILDER_PROTOCOL_VERSION,
  canonicalGraphBuilderAuthoringStringify,
  hashCanonicalGraphBuilderValue,
  parseGraphBuilderDecision,
  parseGraphBuilderDocumentPatchResult,
  parseGraphBuilderReadResult,
  parseGraphValidationResult,
  toBoundedGraphBuilderIdentifier,
  type GraphBuilderDecision,
  type GraphBuilderDocumentPatchResult,
  type GraphBuilderProjection,
  type GraphBuilderProjectDraftDelta,
  type GraphBuilderReadRequest,
  type GraphBuilderReadResult,
  type GraphBuilderSessionResult,
  type GraphDiagnostic,
  type GraphDraftDelta,
  type GraphValidationResult,
} from '../../domain/graphBuilder/index.js';
import type { GraphBuilderCommitOutcome } from './editorGateway.js';
import type { GraphBuilderBaseIdentity } from './identity.js';
import type { VirtualGraphPolicyWorkspaceContext } from './virtualGraphWorkspace.js';

type AuthoringProject = Omit<Project, 'data'>;
type GraphBuilderDocumentEdit =
  | {
      kind: 'unified-diff';
      patchId: string;
      expectedDraftRevision: number;
      unifiedDiff: string;
    }
  | {
      kind: 'replacement';
      patchId: string;
      expectedDraftRevision: number;
      path: string;
      contents: string;
    };

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
  phase: GraphBuilderPolicyPhase;
  userRequest: string;
  draftRevision: number;
  projection: GraphBuilderProjection;
  workspace: VirtualGraphPolicyWorkspaceContext;
  transcript: GraphBuilderTranscriptItem[];
  contextResults: GraphBuilderReadResult[];
  diagnostics: GraphDiagnostic[];
  remainingBudget: GraphBuilderRemainingBudget;
  contextMode: 'full' | 'compacted';
};

export type GraphBuilderPolicyPhase = 'gathering-context' | 'editing' | 'reviewing' | 'repairing';

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
      result: GraphBuilderDocumentPatchResult;
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
  maxPolicyAttempts: 32,
  maxRepairAttempts: 4,
  maxWallTimeMs: 15 * 60_000,
  maxInactivityMs: 4 * 60_000,
  maxTranscriptBytes: 96 * 1024,
  maxPolicyTurnBytes: 256_000,
  clarificationTtlMs: 10 * 60_000,
  maxInputTokens: 500_000,
  maxOutputTokens: 100_000,
  maxCostUsd: 25,
};

export type GraphBuilderPreview = {
  delta: GraphBuilderProjectDraftDelta;
  diagnostics: GraphDiagnostic[];
  draftRevision: number;
  summary: string;
};

export type GraphBuilderSessionViewState =
  | { status: 'created'; sessionId: string }
  | {
      status: GraphBuilderPolicyPhase;
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
  buildWorkspaceContext(): VirtualGraphPolicyWorkspaceContext;
  commit(input: { draft: AuthoringProject; draftRevision: number; summary: string }): GraphBuilderCommitOutcome;
  executePolicy(
    turn: GraphBuilderPolicyTurn,
    abortSignal: AbortSignal,
    reportActivity: () => void,
  ): Promise<GraphBuilderPolicyExecutionResult>;
  kernel: {
    applyDocumentPatch(input: {
      patchId: string;
      expectedDraftRevision: number;
      unifiedDiff: string;
    }): GraphBuilderDocumentPatchResult;
    replaceDocument(input: {
      patchId: string;
      expectedDraftRevision: number;
      path: string;
      contents: string;
    }): GraphBuilderDocumentPatchResult;
    getDraft(): AuthoringProject;
    getDraftDelta(): GraphDraftDelta;
    getProjectDraftDelta(): GraphBuilderProjectDraftDelta;
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

type DocumentCoverage = {
  digest: string;
  intervals: DocumentInterval[];
  totalLength: number;
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
  readonly #turnPatchLedger = new Map<string, GraphBuilderDocumentEdit>();
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
  #consecutiveRepairAttempts = 0;
  #turnSequence = 0;
  #transcript: GraphBuilderTranscriptItem[] = [];
  #contextResults: GraphBuilderReadResult[] = [];
  #documentCoverage = new Map<string, DocumentCoverage>();
  #documentCoverageRevision: number | undefined;
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

  async #runPolicyLoop(initialPhase: GraphBuilderPolicyPhase): Promise<void> {
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
      let workspace: VirtualGraphPolicyWorkspaceContext;
      try {
        projection = this.#options.buildProjection({
          delta: this.#options.kernel.getDraftDelta(),
          diagnostics: this.#diagnostics,
          draft: this.#options.kernel.getDraft(),
          draftRevision,
        });
        workspace = this.#options.buildWorkspaceContext();
        this.#synchronizeDocumentCoverage(workspace, draftRevision);
      } catch (error) {
        this.#fail(
          'projection-failed',
          'Graph Builder could not safely project the current virtual workspace.',
          undefined,
          error,
        );
        return;
      }
      const compacted = compactTranscript(this.#effectiveTranscript(), this.#limits.maxTranscriptBytes);
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
        workspace,
        transcript: compacted.items,
        contextResults: this.#contextResults,
        diagnostics: this.#diagnostics,
        remainingBudget: this.#remainingBudget(nextPolicyAttempt),
        contextMode: transcriptContextMode(compacted),
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
        this.#touchInactivityTimer();
        execution = await waitForAbort(
          this.#options.executePolicy(turn, this.#abortController.signal, () => {
            this.#touchInactivityTimer();
          }),
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
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'invalid-policy-decision',
            'The provider response did not match the Graph Builder decision contract.',
          );
          if (!this.#consumeRepairAttempt()) {
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
        this.#recordPolicyRepairDiagnostic(
          turnId,
          'invalid-policy-decision',
          'The provider response did not match the Graph Builder decision contract.',
        );
        if (!this.#consumeRepairAttempt()) {
          return;
        }
        phase = 'repairing';
        continue;
      }
      this.#transcript.push({ type: 'decision', turnId, draftRevision, decision });

      if (decision.type === 'request-context') {
        const results = await this.#executeReadBatch(decision.requests, turn);
        if (!results) {
          return;
        }
        this.#contextResults = results;
        phase = 'gathering-context';
        continue;
      }

      if (decision.type === 'apply-patch' || decision.type === 'replace-document') {
        if (
          decision.type === 'replace-document' &&
          decision.baseRevision === draftRevision &&
          !this.#hasCompleteDocumentCoverage(decision.path, draftRevision, turn.workspace)
        ) {
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'replacement-requires-complete-document',
            `Read the complete current ${decision.path} document before replacing it. Use nextOffset continuation reads until the current revision is fully covered.`,
          );
          if (!this.#consumeRepairAttempt()) {
            return;
          }
          phase = 'repairing';
          continue;
        }
        let patch: GraphBuilderDocumentEdit;
        try {
          patch = this.#getOrCreateDocumentEdit(turnId, decision);
        } catch (error) {
          this.#fail('patch-identity-error', 'The policy reused a patch identity inconsistently.', undefined, error);
          return;
        }
        let result: GraphBuilderDocumentPatchResult;
        try {
          result = parseGraphBuilderDocumentPatchResult(
            patch.kind === 'unified-diff'
              ? this.#options.kernel.applyDocumentPatch(patch)
              : this.#options.kernel.replaceDocument(patch),
          );
        } catch (error) {
          this.#fail('patch-protocol-error', 'The proposed virtual-document patch was invalid.', undefined, error);
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
          if (!this.#consumeRepairAttempt()) {
            return;
          }
          phase = 'repairing';
          continue;
        }

        if (freshResult.disposition === 'applied') {
          this.#consecutiveRepairAttempts = 0;
        }
        this.#lastSummary =
          decision.summary?.trim() || deterministicSummary(this.#options.kernel.getProjectDraftDelta());
        this.#contextResults = [];

        phase = 'reviewing';
        continue;
      }

      if (decision.type === 'ready') {
        if (!this.#options.kernel.hasDraftChanges()) {
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'ready-without-draft-changes',
            'The policy reported readiness, but the accepted draft matches the captured base.',
          );
          if (!this.#consumeRepairAttempt()) {
            return;
          }
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
          this.#recordPolicyRepairDiagnostic(
            turnId,
            'no-change-with-draft-changes',
            'The policy reported no change while the private draft still differs from the captured base.',
          );
          if (!this.#consumeRepairAttempt()) {
            return;
          }
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
    turn: GraphBuilderPolicyTurn,
  ): Promise<GraphBuilderReadResult[] | undefined> {
    const { draftRevision, turnId } = turn;
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
      const rawResults = outcomes.flatMap((outcome) => (outcome.kind === 'result' ? [outcome.result] : []));
      for (const [requestIndex, result] of rawResults.entries()) {
        const expectedRequestId = createReadRequestId(turnId, requestIndex);
        if (
          result.observedDraftRevision !== draftRevision ||
          result.requestIndex !== requestIndex ||
          result.requestId !== expectedRequestId
        ) {
          this.#fail('mismatched-read-result', 'Graph Builder received an incorrectly correlated context result.');
          return undefined;
        }
      }
      const results = this.#fitReadResultsToNextPolicyTurn(rawResults, turn);
      this.#recordDocumentReadCoverage(results, requests, turn.workspace, draftRevision);
      for (const result of results) {
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

  #fitReadResultsToNextPolicyTurn(
    results: GraphBuilderReadResult[],
    currentTurn: GraphBuilderPolicyTurn,
  ): GraphBuilderReadResult[] {
    const budgetFailures = results.map((result) => readResultBudgetFailure(result));
    const retained = [...budgetFailures];

    for (let requestIndex = 0; requestIndex < results.length; requestIndex += 1) {
      const candidate = [...retained];
      candidate[requestIndex] = results[requestIndex]!;
      if (this.#readResultsFitNextPolicyTurn(candidate, currentTurn)) {
        retained[requestIndex] = results[requestIndex]!;
      }
    }

    return retained;
  }

  #readResultsFitNextPolicyTurn(results: GraphBuilderReadResult[], currentTurn: GraphBuilderPolicyTurn): boolean {
    // The candidate results occupy contextResults on the immediate next turn.
    // They enter the transcript only after that turn, so budgeting them twice
    // would reject useful reads and charge the provider for duplicate context.
    const compacted = compactTranscript(this.#effectiveTranscript(results), this.#limits.maxTranscriptBytes);
    if (compacted.overLimit) {
      return false;
    }

    const nextPolicyAttempt = this.#policyAttempts + 1;
    const nextTurnSequence = this.#turnSequence + 1;
    const nextTurnId = toBoundedGraphBuilderIdentifier(`${this.#sessionId}:turn:${nextTurnSequence}`);
    const prospectiveTurn: GraphBuilderPolicyTurn = {
      ...currentTurn,
      turnId: nextTurnId,
      attemptId: toBoundedGraphBuilderIdentifier(`${nextTurnId}:attempt:${nextPolicyAttempt}`),
      phase: 'gathering-context',
      transcript: compacted.items,
      contextResults: results,
      remainingBudget: this.#remainingBudget(nextPolicyAttempt),
      contextMode: transcriptContextMode(compacted),
    };
    return portableByteLength(prospectiveTurn) <= this.#limits.maxPolicyTurnBytes;
  }

  #effectiveTranscript(
    contextResults: readonly GraphBuilderReadResult[] = this.#contextResults,
  ): GraphBuilderTranscriptItem[] {
    const currentRevision = this.#options.kernel.getDraftRevision();
    const activeReadRequestIds = new Set(contextResults.map((result) => result.requestId));
    return this.#transcript.flatMap((item) => {
      if (item.type !== 'read-result') {
        return [item];
      }
      if (activeReadRequestIds.has(item.result.requestId)) {
        return [];
      }
      return [item.draftRevision === currentRevision ? item : compactTranscriptItem(item)];
    });
  }

  #synchronizeDocumentCoverage(workspace: VirtualGraphPolicyWorkspaceContext, draftRevision: number): void {
    if (this.#documentCoverageRevision !== draftRevision) {
      this.#documentCoverage.clear();
      this.#documentCoverageRevision = draftRevision;
    }

    const currentPaths = new Set(workspace.documents.map((document) => document.path));
    for (const path of this.#documentCoverage.keys()) {
      if (!currentPaths.has(path)) {
        this.#documentCoverage.delete(path);
      }
    }
    for (const descriptor of workspace.documents) {
      const current = this.#documentCoverage.get(descriptor.path);
      if (!current || current.digest !== descriptor.digest || current.totalLength !== descriptor.totalLength) {
        this.#documentCoverage.set(descriptor.path, {
          digest: descriptor.digest,
          intervals: [],
          totalLength: descriptor.totalLength,
        });
      }
    }

    const activeDocument = workspace.activeDocument;
    const descriptor = workspace.documents.find((document) => document.path === activeDocument.path);
    if (
      descriptor &&
      activeDocument.digest === descriptor.digest &&
      activeDocument.totalLength === descriptor.totalLength &&
      activeDocument.startOffset >= 0 &&
      activeDocument.endOffset >= activeDocument.startOffset &&
      activeDocument.endOffset <= descriptor.totalLength &&
      activeDocument.content.length === activeDocument.endOffset - activeDocument.startOffset
    ) {
      this.#addDocumentCoverageInterval(activeDocument.path, [activeDocument.startOffset, activeDocument.endOffset]);
    }
  }

  #recordDocumentReadCoverage(
    results: readonly GraphBuilderReadResult[],
    requests: readonly GraphBuilderReadRequest[],
    workspace: VirtualGraphPolicyWorkspaceContext,
    draftRevision: number,
  ): void {
    if (this.#documentCoverageRevision !== draftRevision) {
      return;
    }
    for (const result of results) {
      const request = requests[result.requestIndex];
      if (request?.type !== 'read-virtual-document') {
        continue;
      }
      for (const descriptor of workspace.documents) {
        const interval = virtualDocumentReadInterval(
          result,
          descriptor.path,
          draftRevision,
          descriptor.totalLength,
          descriptor.digest,
        );
        const requestedStartOffset = request.startOffset;
        const payload = result.status === 'ok' ? result.payload : undefined;
        const resultStartLine =
          payload != null && typeof payload === 'object' && !Array.isArray(payload)
            ? safelyReadProperty(payload, 'startLine')
            : undefined;
        if (
          interval &&
          descriptor.path === request.path &&
          (requestedStartOffset === undefined
            ? resultStartLine === (request.startLine ?? 1)
            : interval[0] === requestedStartOffset)
        ) {
          this.#addDocumentCoverageInterval(descriptor.path, interval);
          break;
        }
      }
    }
  }

  #addDocumentCoverageInterval(path: string, interval: DocumentInterval): void {
    const coverage = this.#documentCoverage.get(path);
    if (!coverage) {
      return;
    }
    coverage.intervals = mergeDocumentIntervals([...coverage.intervals, interval]);
  }

  #hasCompleteDocumentCoverage(
    path: string,
    draftRevision: number,
    workspace: VirtualGraphPolicyWorkspaceContext,
  ): boolean {
    if (this.#documentCoverageRevision !== draftRevision) {
      return false;
    }
    const descriptor = workspace.documents.find((document) => document.path === path);
    const coverage = this.#documentCoverage.get(path);
    return (
      descriptor !== undefined &&
      coverage !== undefined &&
      coverage.digest === descriptor.digest &&
      coverage.totalLength === descriptor.totalLength &&
      (descriptor.totalLength === 0 ||
        (coverage.intervals.length === 1 &&
          coverage.intervals[0]![0] === 0 &&
          coverage.intervals[0]![1] === descriptor.totalLength))
    );
  }

  #getOrCreateDocumentEdit(
    turnId: string,
    decision: Extract<GraphBuilderDecision, { type: 'apply-patch' | 'replace-document' }>,
  ): GraphBuilderDocumentEdit {
    const previous = this.#turnPatchLedger.get(turnId);
    if (previous) {
      const contentMatches =
        decision.type === 'apply-patch'
          ? previous.kind === 'unified-diff' && previous.unifiedDiff === decision.unifiedDiff
          : previous.kind === 'replacement' &&
            previous.path === decision.path &&
            previous.contents === decision.content;
      if (previous.expectedDraftRevision !== decision.baseRevision || !contentMatches) {
        throw new Error('A policy turn reused its identity with different patch content.');
      }
      return previous;
    }

    const common = {
      patchId: toBoundedGraphBuilderIdentifier(`${turnId}:patch`),
      // Let the workspace turn stale model revisions into an ordinary
      // rejected edit with a current-revision repair diagnostic. Treating
      // this as a controller protocol failure would make a recoverable model
      // mistake terminate the entire session.
      expectedDraftRevision: decision.baseRevision,
    };
    const patch =
      decision.type === 'apply-patch'
        ? { ...common, kind: 'unified-diff' as const, unifiedDiff: decision.unifiedDiff }
        : {
            ...common,
            kind: 'replacement' as const,
            path: decision.path,
            contents: decision.content,
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
      return !this.#consumeRepairAttempt();
    }
    const delta = this.#options.kernel.getProjectDraftDelta();
    const preview: GraphBuilderPreview = {
      delta,
      diagnostics: this.#diagnostics,
      draftRevision: this.#options.kernel.getDraftRevision(),
      summary: summary.trim() || deterministicSummary(delta),
    };
    if (!this.#checkHardDeadline()) {
      return true;
    }
    // Automated work is complete. Preview review is user-paced and therefore
    // is not bounded by provider/read inactivity or the active-work deadline.
    this.#clearInactivityTimer();
    this.#clearDeadlineTimer();
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
    if (this.#consecutiveRepairAttempts > this.#limits.maxRepairAttempts) {
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
      repairAttempts: Math.max(0, this.#limits.maxRepairAttempts - this.#consecutiveRepairAttempts),
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

  #clearDeadlineTimer(): void {
    if (this.#deadlineTimer) {
      clearTimeout(this.#deadlineTimer);
      this.#deadlineTimer = undefined;
    }
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
    this.#clearDeadlineTimer();
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

  #consumeRepairAttempt(): boolean {
    this.#repairAttempts += 1;
    this.#consecutiveRepairAttempts += 1;
    if (this.#consecutiveRepairAttempts <= this.#limits.maxRepairAttempts) {
      return true;
    }
    this.#terminate({
      status: 'budget-exhausted',
      diagnostics: this.#diagnostics,
    });
    return false;
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

type DocumentInterval = readonly [startOffset: number, endOffset: number];

function mergeDocumentIntervals(intervals: readonly DocumentInterval[]): DocumentInterval[] {
  const merged: DocumentInterval[] = [];
  for (const [startOffset, endOffset] of [...intervals].sort(
    ([leftStart, leftEnd], [rightStart, rightEnd]) => leftStart - rightStart || rightEnd - leftEnd,
  )) {
    const previous = merged.at(-1);
    if (!previous || startOffset > previous[1]) {
      merged.push([startOffset, endOffset]);
    } else if (endOffset > previous[1]) {
      merged[merged.length - 1] = [previous[0], endOffset];
    }
  }
  return merged;
}

function virtualDocumentReadInterval(
  result: GraphBuilderReadResult,
  path: string,
  draftRevision: number,
  totalLength: number,
  digest: string,
): DocumentInterval | undefined {
  if (result.status !== 'ok' || result.observedDraftRevision !== draftRevision) {
    return undefined;
  }
  const payload = result.payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const payloadPath = safelyReadProperty(payload, 'path');
  const payloadRevision = safelyReadProperty(payload, 'draftRevision');
  const payloadDigest = safelyReadProperty(payload, 'digest');
  const payloadTotalLength = safelyReadProperty(payload, 'totalLength');
  const startOffset = safelyReadProperty(payload, 'startOffset');
  const endOffset = safelyReadProperty(payload, 'endOffset');
  const contents = safelyReadProperty(payload, 'contents');
  if (
    payloadPath !== path ||
    payloadRevision !== draftRevision ||
    payloadDigest !== digest ||
    payloadTotalLength !== totalLength ||
    typeof startOffset !== 'number' ||
    !Number.isSafeInteger(startOffset) ||
    startOffset < 0 ||
    typeof endOffset !== 'number' ||
    !Number.isSafeInteger(endOffset) ||
    endOffset < startOffset ||
    endOffset > totalLength ||
    typeof contents !== 'string' ||
    contents.length !== endOffset - startOffset
  ) {
    return undefined;
  }
  return [startOffset, endOffset];
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

function transcriptContextMode(
  transcript: ReturnType<typeof compactTranscript>,
): GraphBuilderPolicyTurn['contextMode'] {
  return transcript.compacted || transcript.items.some((item) => item.type === 'compacted') ? 'compacted' : 'full';
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
      if (item.decision.type === 'apply-patch') {
        return `Decision proposed a virtual-document patch for revision ${item.decision.baseRevision.toString(10)}.`;
      }
      if (item.decision.type === 'replace-document') {
        return `Decision proposed replacing ${item.decision.path} at revision ${item.decision.baseRevision.toString(10)}.`;
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
  // Aggregate transcripts and parallel read batches may temporarily exceed the
  // per-envelope portable limit before compaction. Measure those data-only
  // candidates with the larger authoring serializer, then enforce the much
  // tighter session limit at each caller.
  return new TextEncoder().encode(canonicalGraphBuilderAuthoringStringify(value)).byteLength;
}

function createReadRequestId(turnId: string, requestIndex: number): string {
  return toBoundedGraphBuilderIdentifier(`${turnId}:read:${requestIndex}`);
}

function readResultBudgetFailure(result: GraphBuilderReadResult): GraphBuilderReadResult {
  return {
    requestId: result.requestId,
    requestIndex: result.requestIndex,
    observedDraftRevision: result.observedDraftRevision,
    status: 'failed',
    error: {
      code: 'read-result-budget-exceeded',
      message: 'This result did not fit the aggregate Graph Builder context budget. Request fewer or narrower reads.',
    },
  };
}

function deterministicSummary(delta: GraphBuilderProjectDraftDelta | undefined): string {
  if (!delta || delta.graphDeltas.length === 0) {
    return 'Prepared a validated graph change.';
  }
  const graphDeltas = delta.graphDeltas;
  const sum = (value: (graphDelta: GraphDraftDelta) => number) =>
    graphDeltas.reduce((total, graphDelta) => total + value(graphDelta), 0);
  const parts = [
    pluralize(
      sum((entry) => entry.addedNodeCount ?? entry.addedNodes.length),
      'node added',
      'nodes added',
    ),
    pluralize(
      sum((entry) => entry.updatedNodeCount ?? entry.updatedNodes.length),
      'node updated',
      'nodes updated',
    ),
    pluralize(
      sum((entry) => entry.removedNodeCount ?? entry.removedNodes.length),
      'node removed',
      'nodes removed',
    ),
    pluralize(
      sum((entry) => entry.addedConnectionCount ?? entry.addedConnections.length),
      'connection added',
      'connections added',
    ),
    pluralize(
      sum((entry) => entry.removedConnectionCount ?? entry.removedConnections.length),
      'connection removed',
      'connections removed',
    ),
    pluralize(graphDeltas.length, 'graph changed', 'graphs changed'),
  ].filter((part) => !part.startsWith('0 '));
  return parts.length > 0 ? `Prepared ${parts.join(', ')}.` : 'Prepared a validated graph change.';
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function progressForPhase(phase: GraphBuilderPolicyPhase): string {
  switch (phase) {
    case 'gathering-context':
      return 'Inspecting the available graph-building context…';
    case 'editing':
      return 'Preparing a private graph draft…';
    case 'reviewing':
      return 'Checking the accepted draft against the complete request…';
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
