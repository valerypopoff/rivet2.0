import { useRef, useState } from 'react';
import { useAtom } from 'jotai';
import { promptDesignerResponseState } from '../../state/promptDesigner.js';
import { useGetAdHocInternalProcessContext } from '../../hooks/useGetAdHocInternalProcessContext.js';
import { runAdHocChat } from './runAdHocChat.js';
import { handleError } from '../../utils/errorHandling.js';

export const usePromptDesignerRunActions = ({
  configData,
  messages,
}: {
  configData: Parameters<typeof runAdHocChat>[1];
  messages: Parameters<typeof runAdHocChat>[0];
}) => {
  const [response, setResponse] = useAtom(promptDesignerResponseState);
  const getAdHocInternalProcessContext = useGetAdHocInternalProcessContext();
  const abortController = useRef<AbortController>();
  const [inProgress, setInProgress] = useState(false);

  const tryRunSingle = async () => {
    try {
      abortController.current?.abort();
      abortController.current = new AbortController();
      setInProgress(true);
      setResponse({});

      const nextResponse = await runAdHocChat(
        messages,
        configData,
        await getAdHocInternalProcessContext({
          onPartialResult: (partialResult) => {
            setResponse({ response: partialResult });
          },
          signal: abortController.current.signal,
        }),
      );

      setResponse({ response: nextResponse });
    } catch (error) {
      handleError(error, 'Failed to run prompt designer chat', {
        metadata: {
          messageCount: messages.length,
        },
      });
    } finally {
      abortController.current = undefined;
      setInProgress(false);
    }
  };

  return {
    inProgress,
    response,
    tryRunSingle,
  };
};
