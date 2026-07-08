import { useContext, useEffect, useRef, useState } from 'react';
import {
  getError,
  type ChartNode,
  type CustomEditorDefinition,
  coreCreateProcessor,
  deserializeProject,
  registerBuiltInNodes,
  NodeRegistration,
} from '@valerypopoff/rivet2-core';
import { Field } from '@atlaskit/form';
import Button from '@atlaskit/button';
import { css } from '@emotion/react';
import { toast } from 'react-toastify';
import codeGeneratorProject from '../../../../graphs/code-node-generator.rivet-project?raw';
import { useAtomValue } from 'jotai';
import { settingsState } from '../../../state/settings';
import { fillMissingSettingsFromEnvironmentVariables } from '../../../utils/tauri';
import { useDependsOnPlugins } from '../../../hooks/useDependsOnPlugins';
import { marked } from 'marked';
import TextArea from '@atlaskit/textarea';
import {
  aiAssistCustomModelState,
  aiAssistCustomProviderBaseURLState,
  selectedAssistModelState,
} from '../../../state/ai';
import { handleError } from '../../../utils/errorHandling.js';
import { useMultilineEditorFontSize } from '../../../hooks/useMultilineEditorFontSize.js';
import Collapsible from 'react-collapsible';
import ChevronDownIcon from 'majesticons/line/chevron-down-line.svg?react';
import ChevronUpIcon from 'majesticons/line/chevron-up-line.svg?react';
import { useEnvironmentProvider } from '../../../providers/ProvidersContext.js';
import { NodeCodeEditorFooterActionContext } from '../NodeCodeEditorFooterActionContext.js';
import SparklesIcon from '../../../assets/icons/ai-sparks-solid.svg?react';
import { Tooltip } from '../../Tooltip.js';
import { resolveAiAssistModelSettings } from '../../../utils/aiAssistModelSettings.js';
import { createAiAssistVercelGeneratorChatNodeDefinition } from '../../../utils/aiAssistVercelGenerator.js';
import { AiAssistPromptModal } from '../../AiAssistPromptModal.js';

const AI_ASSIST_CANCEL_REASON = 'Generate using AI canceled';

const styles = css`
  --ai-assist-radius: calc(16px * var(--ui-font-scale));
  --ai-assist-toggle-radius: calc(8px * var(--ui-font-scale));
  --ai-assist-padding-x: calc(16px * var(--ui-font-scale));
  --ai-assist-toggle-padding-y: calc(8px * var(--ui-font-scale));
  --ai-assist-toggle-icon-size: calc(24px * var(--ui-font-scale));

  @supports not (corner-shape: squircle) {
    --ai-assist-radius: calc(8px * var(--ui-font-scale));
    --ai-assist-toggle-radius: calc(4px * var(--ui-font-scale));
  }

  grid-column: span 2;

  .ai-assist-toggle-container {
    display: flex;
    flex-direction: column;
    padding-left: var(--ai-assist-padding-x);
    padding-right: var(--ai-assist-padding-x);
    border: 1px solid var(--settings-collapsible-border);
    border-radius: var(--ai-assist-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-header-bg);
  }

  .ai-assist-toggle-area {
    display: flex;
    flex-direction: column;
  }

  > .Collapsible > .ai-assist-toggle-container.open {
    border-bottom: none;
    border-radius: var(--ai-assist-radius) var(--ai-assist-radius) 0 0;
    corner-shape: squircle;
  }

  > .Collapsible > .ai-assist-toggle-container.open + .Collapsible__contentOuter {
    border: 1px solid var(--settings-collapsible-border);
    border-top: none;
    border-radius: 0 0 var(--ai-assist-radius) var(--ai-assist-radius);
    corner-shape: squircle;
    background: var(--settings-collapsible-body-bg);
  }

  .ai-assist-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--ai-assist-toggle-padding-y) var(--ai-assist-padding-x);
    margin: 0 calc(-1 * var(--ai-assist-padding-x));
    border: none;
    background: none;
    cursor: pointer;
    outline: none;
    border-radius: var(--ai-assist-toggle-radius);
    corner-shape: squircle;
    transition: background 0.2s ease-out;
    font-size: var(--ui-font-size-base);
    line-height: 1.25;
    font-family: inherit;
    color: var(--label-color);
    font-weight: var(--label-font-weight);

    .indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--ai-assist-toggle-icon-size);
      height: var(--ai-assist-toggle-icon-size);
      flex: 0 0 var(--ai-assist-toggle-icon-size);
    }

    &:hover {
      background: var(--settings-collapsible-hover-bg);
    }
  }

  .ai-assist-body {
    display: flex;
    flex-direction: column;
    gap: calc(12px * var(--ui-font-scale));
    margin: 0;
  }

  .ai-assist-panel {
    margin-top: 0;
    padding: 6px 16px 16px;
  }

  .ai-assist-action-row {
    display: flex;
    gap: calc(8px * var(--ui-font-scale));
    justify-content: flex-end;
  }

  .ai-assist-model-note {
    color: var(--grey-light);
    font-size: var(--ui-font-size-sm);
    line-height: 1.35;

    strong {
      color: var(--foreground);
      font-weight: 600;
    }
  }

  .ai-assist-textarea-shell + .ai-assist-model-note {
    margin-top: calc(4px * var(--ui-font-scale));
  }

  .ai-assist-missing-configuration {
    color: var(--warning);
  }

  .ai-assist-textarea-shell {
    width: 100%;
  }

  .ai-assist-textarea-shell .text-area,
  .ai-assist-textarea-shell textarea {
    width: 100%;
  }

  .ai-assist-textarea-shell textarea {
    border-radius: var(--ui-button-radius);
    corner-shape: squircle;
  }
`;

export interface AiAssistEditorBaseProps<TNodeData, TOutputs> {
  node: ChartNode;
  data: TNodeData;
  isReadonly: boolean;
  isDisabled: boolean;
  editor: CustomEditorDefinition<ChartNode>;
  onChange: (node: ChartNode) => void;
  graphName: string;
  updateData: (data: TNodeData, result: TOutputs) => TNodeData | null;
  placeholder: string;
  label?: string;
  buildGeneratorPrompt?: (prompt: string, context: { selectedText?: string }) => string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  onError?: (error: any) => void;
  onSuccess?: (updatedNode: ChartNode) => void;
  getErrorMessage?: (outputs: TOutputs) => string;
  getIsError?: (outputs: TOutputs) => boolean;
}

export const AiAssistEditorBase = <TNodeData, TOutputs>({
  node,
  data,
  isReadonly,
  isDisabled,
  onChange,
  graphName,
  updateData,
  placeholder,
  label = 'Generate Using AI',
  buildGeneratorPrompt,
  collapsible = false,
  defaultOpen = true,
  onError,
  onSuccess,
  getErrorMessage,
  getIsError,
}: AiAssistEditorBaseProps<TNodeData, TOutputs>) => {
  const [prompt, setPrompt] = useState('');
  const [working, setWorking] = useState(false);
  const [footerModalOpen, setFooterModalOpen] = useState(false);
  const [selectedTextContext, setSelectedTextContext] = useState<string>();
  const generationInFlightRef = useRef(false);
  const activeGenerationIdRef = useRef<symbol | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const currentNodeIdRef = useRef(node.id);
  const latestNodeRef = useRef(node);
  const latestDataRef = useRef(data);

  latestNodeRef.current = node;
  latestDataRef.current = data;

  const settings = useAtomValue(settingsState);
  const plugins = useDependsOnPlugins();
  const environmentProvider = useEnvironmentProvider();
  const selectedAssistModel = useAtomValue(selectedAssistModelState);
  const customAssistProviderBaseURL = useAtomValue(aiAssistCustomProviderBaseURLState);
  const customAssistModel = useAtomValue(aiAssistCustomModelState);

  const assistModel = resolveAiAssistModelSettings({
    customModel: customAssistModel,
    customProviderBaseURL: customAssistProviderBaseURL,
    selectedModel: selectedAssistModel,
  });
  const {
    fontSize,
    handleKeyDown: handleMultilineEditorFontSizeKeyDown,
    handleWheel: handleMultilineEditorFontSizeWheel,
  } = useMultilineEditorFontSize();
  const footerActionBridge = useContext(NodeCodeEditorFooterActionContext);
  const useFooterTrigger = collapsible && footerActionBridge != null;
  const footerLabel = label === 'Generate Using AI' ? 'Generate using AI' : label;

  const abortGeneration = () => {
    abortControllerRef.current?.abort(AI_ASSIST_CANCEL_REASON);
  };

  const closeFooterModal = () => {
    abortGeneration();
    setFooterModalOpen(false);
  };

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      abortControllerRef.current?.abort(AI_ASSIST_CANCEL_REASON);
    };
  }, []);

  useEffect(() => {
    if (currentNodeIdRef.current === node.id) {
      return;
    }

    abortControllerRef.current?.abort(AI_ASSIST_CANCEL_REASON);
    activeGenerationIdRef.current = null;
    abortControllerRef.current = null;
    generationInFlightRef.current = false;
    setWorking(false);
    setFooterModalOpen(false);
    setSelectedTextContext(undefined);
    currentNodeIdRef.current = node.id;
  }, [node.id]);

  useEffect(() => {
    if (!useFooterTrigger) {
      return undefined;
    }

    footerActionBridge.setFooterLeftAction(
      <Tooltip content={footerLabel} tag="span">
        <button
          type="button"
          className="node-editor-code-ai-footer-button"
          aria-label={footerLabel}
          aria-expanded={footerModalOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setSelectedTextContext(footerActionBridge.getSelectedText());
            setFooterModalOpen(true);
          }}
        >
          <SparklesIcon />
        </button>
      </Tooltip>,
    );

    return () => {
      footerActionBridge.setFooterLeftAction(null);
    };
  }, [footerActionBridge, footerLabel, footerModalOpen, useFooterTrigger]);

  const buildPromptInput = () => {
    const selectedText = selectedTextContext?.length ? selectedTextContext : undefined;

    if (buildGeneratorPrompt) {
      return buildGeneratorPrompt(prompt, { selectedText });
    }

    if (!selectedText) {
      return prompt;
    }

    return [
      'Use the selected editor content as context for this generation request.',
      '',
      '<selected_editor_content>',
      selectedText,
      '</selected_editor_content>',
      '',
      '<user_request>',
      prompt,
      '</user_request>',
    ].join('\n');
  };

  const generate = async () => {
    if (isReadonly || isDisabled || assistModel.missingConfiguration || generationInFlightRef.current) {
      return;
    }

    const generationId = Symbol('ai-assist-generation');
    const generationNodeId = node.id;
    const abortController = new AbortController();
    const isCurrentGenerationCanceled = () =>
      abortController.signal.aborted ||
      activeGenerationIdRef.current !== generationId ||
      latestNodeRef.current.id !== generationNodeId;

    activeGenerationIdRef.current = generationId;
    abortControllerRef.current = abortController;
    generationInFlightRef.current = true;
    setWorking(true);

    try {
      const [project] = deserializeProject(codeGeneratorProject);

      const registry = registerBuiltInNodes(new NodeRegistration());
      const resolvedSettings = await fillMissingSettingsFromEnvironmentVariables(settings, plugins, {
        environmentProvider,
      });
      const generationAssistModel = resolveAiAssistModelSettings({
        customModel: customAssistModel,
        customProviderBaseURL: customAssistProviderBaseURL,
        selectedModel: selectedAssistModel,
      });

      if (isCurrentGenerationCanceled()) {
        return;
      }

      registry.register(createAiAssistVercelGeneratorChatNodeDefinition(generationAssistModel));

      const processor = coreCreateProcessor(project, {
        graph: graphName,
        inputs: {
          prompt: buildPromptInput(),
          model: generationAssistModel.model,
          api: generationAssistModel.graphApi,
        },
        registry,
        ...resolvedSettings,
        abortSignal: abortController.signal,
      });

      const outputs = (await processor.run()) as TOutputs;

      if (isCurrentGenerationCanceled()) {
        return;
      }

      const isErrorResponse = getIsError ? getIsError(outputs) : false;

      if (!isErrorResponse) {
        const baseNode = latestNodeRef.current.id === node.id ? latestNodeRef.current : node;
        const baseData = latestNodeRef.current.id === node.id ? latestDataRef.current : data;
        const updatedData = updateData(baseData, outputs);

        if (updatedData) {
          const updatedNode = {
            ...baseNode,
            data: updatedData,
          };

          onChange(updatedNode);

          // Call success callback if provided
          if (onSuccess) {
            onSuccess(updatedNode);
          }
        }
      } else {
        // Handle error response
        const responseText = getErrorMessage ? getErrorMessage(outputs) : 'An error occurred';

        const markdownResponse = marked(responseText);
        toast.info(<div dangerouslySetInnerHTML={{ __html: markdownResponse }}></div>, {
          autoClose: false,
          containerId: 'wide',
          toastId: 'ai-assist-response',
        });
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }

      const error = getError(err);
      handleError(error, 'Failed to generate AI assist content', {
        metadata: {
          graphName,
          model: assistModel.displayName,
          nodeId: node.id,
          promptLength: prompt.length,
        },
      });

      // Call error callback if provided
      if (onError) {
        onError(error);
      }
    } finally {
      if (activeGenerationIdRef.current === generationId) {
        activeGenerationIdRef.current = null;
        abortControllerRef.current = null;
        generationInFlightRef.current = false;

        if (isMountedRef.current) {
          setWorking(false);
        }
      }
    }
  };

  const generateDisabled = isReadonly || isDisabled || working || Boolean(assistModel.missingConfiguration);
  const cancelButton = working ? (
    <Button aria-label="Cancel generation" onClick={abortGeneration}>
      Cancel
    </Button>
  ) : null;

  const modelNote = (
    <div className="ai-assist-model-note">
      <span>
        Using <strong>{assistModel.displayName}</strong>. To change it, go to Settings &gt; LLM.
      </span>
      {assistModel.missingConfiguration && (
        <div className="ai-assist-missing-configuration">{assistModel.missingConfiguration}</div>
      )}
    </div>
  );

  const renderPromptTextArea = (minimumRows: number, placeholderText = placeholder) => (
    <div className="ai-assist-textarea-shell">
      <TextArea
        isDisabled={isDisabled || working}
        isReadOnly={isReadonly}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholderText}
        className="text-area"
        onKeyDown={(e) => {
          if (handleMultilineEditorFontSizeKeyDown(e.nativeEvent)) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }

          if (!generateDisabled && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            void generate();
          }
        }}
        onWheel={(e) => handleMultilineEditorFontSizeWheel(e.nativeEvent)}
        minimumRows={minimumRows}
        resize="vertical"
        style={{ fontSize }}
      />
    </div>
  );

  const editorBody = (
    <div className={collapsible ? 'ai-assist-panel' : undefined}>
      <div className="ai-assist-body">
        {renderPromptTextArea(3)}
        {modelNote}
        <div className="ai-assist-action-row">
          {cancelButton}
          <Button appearance="primary" onClick={() => void generate()} isDisabled={generateDisabled}>
            Generate
          </Button>
        </div>
      </div>
    </div>
  );

  if (!collapsible) {
    return (
      <Field name="aiAssist" label={label}>
        {() => <div css={styles}>{editorBody}</div>}
      </Field>
    );
  }

  if (useFooterTrigger) {
    return (
      <AiAssistPromptModal
        generateDisabled={generateDisabled}
        isDisabled={isDisabled}
        isOpen={footerModalOpen}
        isReadonly={isReadonly}
        missingConfiguration={assistModel.missingConfiguration}
        modelDisplayName={assistModel.displayName}
        onCancel={abortGeneration}
        onClose={closeFooterModal}
        onGenerate={() => void generate()}
        onPromptChange={setPrompt}
        prompt={prompt}
        title={footerLabel}
        working={working}
      />
    );
  }

  const toggle = (isOpen?: boolean) => (
    <div className="ai-assist-toggle-area">
      <button type="button" className="ai-assist-toggle">
        <span className="label">{label}</span>
        <span className="indicator">{isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
      </button>
    </div>
  );

  return (
    <div css={styles}>
      <Collapsible
        open={defaultOpen}
        trigger={toggle(false)}
        triggerClassName="ai-assist-toggle-container"
        triggerOpenedClassName="ai-assist-toggle-container open"
        triggerWhenOpen={toggle(true)}
        transitionTime={150}
        easing="ease-out"
      >
        {editorBody}
      </Collapsible>
    </div>
  );
};
