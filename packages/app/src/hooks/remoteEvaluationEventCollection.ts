import type { ProcessEventMessageMap, RemoteRunRequestId } from '@valerypopoff/rivet2-core';
import type { EvaluationEventCollector } from '@valerypopoff/rivet2-evaluations';
import type { ExecutorSessionRuntime } from './executorSession.js';

type MessageHandler = Parameters<ExecutorSessionRuntime['subscribeMessages']>[0];

/** Account at the subscription boundary before project or active-canvas routing. */
export function withRemoteEvaluationAccounting(
  collectorsByRequestId: ReadonlyMap<RemoteRunRequestId, EvaluationEventCollector>,
  handleMessage: MessageHandler,
): MessageHandler {
  return (message, data, requestId) => {
    const collector = requestId == null ? undefined : collectorsByRequestId.get(requestId);
    switch (message) {
      case 'llmCallFinished':
        collector?.llmCallFinished(data as ProcessEventMessageMap['llmCallFinished']);
        break;
      case 'llmProfileAttempt':
        collector?.llmProfileAttempt(data as ProcessEventMessageMap['llmProfileAttempt']);
        break;
      case 'toolCallFinished':
        collector?.toolCallFinished(data as ProcessEventMessageMap['toolCallFinished']);
        break;
    }
    handleMessage(message, data, requestId);
  };
}
