import { useLayoutEffect, useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { promptDesignerResponseState } from '../../state/promptDesigner.js';
import { useGetAdHocInternalProcessContext } from '../../hooks/useGetAdHocInternalProcessContext.js';
import { runAdHocChat } from './runAdHocChat.js';
import { handleError } from '../../utils/errorHandling.js';

export const usePromptDesignerRunActions = ({
  configData,
  messages,
  attachmentKey,
}: {
  configData: Parameters<typeof runAdHocChat>[1];
  messages: Parameters<typeof runAdHocChat>[0];
  attachmentKey?: string;
}) => {
  const [response, setResponse] = useAtom(promptDesignerResponseState);
  const getAdHocInternalProcessContext = useGetAdHocInternalProcessContext();
  const abortController = useRef<AbortController>();
  const [inProgress, setInProgress] = useState(false);
  useLayoutEffect(() => {
    setResponse({});
    setInProgress(false);
    return () => {
      const previous = abortController.current;
      abortController.current = undefined;
      previous?.abort();
    };
  }, [attachmentKey, setResponse]);

  const tryRunSingle = async () => {
    const controller = new AbortController();
    const isCurrent = () => abortController.current === controller && !controller.signal.aborted;
    try {
      abortController.current?.abort();
      abortController.current = controller;
      setInProgress(true);
      setResponse({});

      const context = await getAdHocInternalProcessContext({
        onPartialResult: (partialResult) => {
          if (isCurrent()) setResponse({ response: partialResult });
        },
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const nextResponse = await runAdHocChat(messages, configData, context);

      if (isCurrent()) setResponse({ response: nextResponse });
    } catch (error) {
      if (isCurrent())
        handleError(error, 'Failed to run prompt designer chat', {
          metadata: {
            messageCount: messages.length,
          },
        });
    } finally {
      if (abortController.current === controller) {
        abortController.current = undefined;
        setInProgress(false);
      }
    }
  };

  return {
    inProgress,
    response,
    tryRunSingle,
  };
};
