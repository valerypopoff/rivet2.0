import { randomUUID } from 'node:crypto';
import {
  type GraphProcessor,
  isLatestDebuggerScope,
  encodeLatestDebuggerEnvelope,
  type LatestDebuggerChannel,
  type LatestDebuggerScope,
  type LatestDebuggerControlResult,
  type LatestDebuggerLifecycleMessage,
} from '@valerypopoff/rivet2-core';
import type { RivetDebuggerServer } from '@valerypopoff/rivet2-node';

type Binding = {
  channel: LatestDebuggerChannel;
  scope?: LatestDebuggerScope;
  processor: GraphProcessor;
  debuggerServer: RivetDebuggerServer;
  prompts: Map<string, { graphRunId: string; processId: string; callback: (answers: unknown) => void }>;
  cleanup?: () => void;
  paused?: boolean;
  abortRequested?: boolean;
};
export type LatestControlResult = LatestDebuggerControlResult;

/** Only request-owned processors enter this index. Observers never own execution. */
export class LatestDebuggerPolicy {
  private bindings = new WeakMap<GraphProcessor, Binding>();
  private roots = new Map<string, Binding>();
  private diagnostics: Array<{ message: string; reason: string }> = [];
  constructor(
    private readonly owner: string,
    private readonly incarnation: string,
    private readonly report: (reason: 'ownership' | 'broadcast') => void = () => {},
  ) {}
  private rejectEvent(message: string, reason: string): '' {
    try {
      this.report(reason === 'broadcast-failed' ? 'broadcast' : 'ownership');
    } catch {
      /* observational */
    }
    this.diagnostics.push({ message: message.slice(0, 128), reason });
    if (this.diagnostics.length > 32) this.diagnostics.shift();
    return '';
  }
  getDiagnostics() {
    return this.diagnostics.map((item) => ({ ...item }));
  }

  private publish<M extends LatestDebuggerLifecycleMessage['message']>(
    binding: Binding,
    message: M,
    data: Extract<LatestDebuggerLifecycleMessage, { message: M }>['data'],
  ) {
    try {
      binding.debuggerServer.broadcast(binding.processor, message, data);
    } catch {
      // Observers never own accepted work or processor-registration cleanup.
      this.rejectEvent(message, 'broadcast-failed');
    }
  }

  forChannel(debuggerServer: RivetDebuggerServer, channel: LatestDebuggerChannel): RivetDebuggerServer {
    return {
      ...debuggerServer,
      attach: (processor, requestId) => {
        const existing = this.bindings.get(processor);
        if (existing && existing.channel !== channel)
          throw new Error('An attached execution cannot change debugger channels');
        if (!this.bindings.has(processor)) {
          const binding: Binding = { processor, debuggerServer, channel, prompts: new Map() };
          this.bindings.set(processor, binding);
          binding.cleanup = () => {
            if (binding.scope && this.roots.get(binding.scope.rootRunId) === binding)
              this.roots.delete(binding.scope.rootRunId);
            binding.prompts.clear();
            this.bindings.delete(processor);
            off();
          };
          const off = processor.on('finish', () => {
            if (binding.scope) this.publish(binding, 'latest-settled', {});
            binding.cleanup?.();
          });
        }
        debuggerServer.attach(processor, requestId);
      },
      detach: (processor) => {
        this.bindings.get(processor)?.cleanup?.();
        debuggerServer.detach(processor);
      },
    };
  }

  decorate(payload: string, processor: GraphProcessor, message: string, raw: unknown): string {
    const binding = this.bindings.get(processor);
    if (!binding) return this.rejectEvent(message, 'unregistered-processor');
    const data = raw as
      | {
          execution?: { rootRunId?: string; projectId?: string; parentGraphRunId?: string; graphRunId?: string };
          callback?: (answers: unknown) => void;
          processId?: string;
        }
      | undefined;
    if (
      !binding.scope &&
      message === 'start' &&
      data?.execution?.rootRunId &&
      data.execution.projectId &&
      !data.execution.parentGraphRunId
    ) {
      binding.scope = {
        channel: binding.channel,
        rootRunId: data.execution.rootRunId,
        projectId: data.execution.projectId,
        owner: this.owner,
        incarnation: this.incarnation,
        admittedAt: Date.now(),
        promptLifecycle: 1,
      };
      const existing = this.roots.get(binding.scope.rootRunId);
      if (existing && existing !== binding) return this.rejectEvent(message, 'duplicate-root');
      this.roots.set(binding.scope.rootRunId, binding);
    }
    if (
      !binding.scope ||
      this.roots.get(binding.scope.rootRunId) !== binding ||
      (data?.execution?.rootRunId && data.execution.rootRunId !== binding.scope.rootRunId)
    )
      return this.rejectEvent(message, 'missing-or-contradictory-root');
    if (message === 'pause') binding.paused = true;
    if (message === 'resume') binding.paused = false;
    if (message === 'abort') binding.abortRequested = true;
    let scope = binding.scope;
    if (
      message === 'userInput' &&
      typeof data?.callback === 'function' &&
      data.execution?.graphRunId &&
      data.processId
    ) {
      const promptId = randomUUID();
      binding.prompts.set(promptId, {
        callback: data.callback,
        graphRunId: data.execution.graphRunId,
        processId: data.processId,
      });
      scope = { ...scope, promptId };
    }
    if (['done', 'error', 'abort'].includes(message)) binding.prompts.clear();
    if (['nodeFinish', 'nodeError', 'nodeExcluded', 'graphAbort', 'graphError'].includes(message))
      for (const [id, prompt] of binding.prompts)
        if (
          prompt.processId === data?.processId ||
          (message.startsWith('graph') && prompt.graphRunId === data?.execution?.graphRunId)
        )
          binding.prompts.delete(id);
    return encodeLatestDebuggerEnvelope(payload, scope);
  }

  control(input: unknown, channel: LatestDebuggerChannel): LatestControlResult {
    const command = input as {
      target?: LatestDebuggerScope;
      action?: string;
      promptId?: string;
      answers?: { type?: string; value?: unknown };
    };
    if (
      !isLatestDebuggerScope(command?.target) ||
      command.target.channel !== channel ||
      command.target.owner !== this.owner ||
      command.target.incarnation !== this.incarnation
    )
      return { status: 'rejected', reason: 'Execution channel or owner does not match' };
    const binding = this.roots.get(command.target.rootRunId);
    if (!binding?.scope || binding.channel !== channel || binding.scope.projectId !== command.target.projectId)
      return { status: 'rejected', reason: 'Execution is no longer available' };
    if (binding.abortRequested) return { status: 'rejected', reason: 'Execution cancellation is already in progress' };
    switch (command.action) {
      case 'pause':
        if (binding.paused) return { status: 'rejected', reason: 'Execution is already paused' };
        binding.processor.pause();
        binding.paused = true;
        break;
      case 'resume':
        if (!binding.paused) return { status: 'rejected', reason: 'Execution is not paused' };
        binding.processor.resume();
        binding.paused = false;
        break;
      case 'abort':
        binding.abortRequested = true;
        binding.prompts.clear();
        void binding.processor.abort().catch(() => {});
        break;
      case 'user-input': {
        const promptId = command.promptId;
        const prompt = promptId ? binding.prompts.get(promptId) : undefined;
        if (
          !prompt ||
          !promptId ||
          command.answers?.type !== 'string[]' ||
          !Array.isArray(command.answers.value) ||
          !command.answers.value.every((v) => typeof v === 'string')
        )
          return { status: 'rejected', reason: 'Prompt is stale or answer is invalid' };
        binding.prompts.delete(promptId);
        // Publish only the consumed identity, never the answer/callback. Every
        // observer and late replay sees closure through the existing scoped ring.
        this.publish(binding, 'latest-prompt-closed', { promptId });
        prompt.callback(command.answers);
        break;
      }
      default:
        return { status: 'rejected', reason: 'Unsupported latest debugger control' };
    }
    return { status: 'accepted' };
  }
}
