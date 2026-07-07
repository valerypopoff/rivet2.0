import { type FC, type ReactNode, useMemo, useRef, useState } from 'react';
import {
  type ChartNode,
  type CodeEditorDefinition,
  coerceTypeOptional,
  type CustomEditorDefinition,
  type DataValue,
} from '@valerypopoff/rivet2-core';
import { toast } from 'react-toastify';
import { type SharedEditorProps } from './SharedEditorProps';
import { NodeCodeEditorFooterActionContext } from './NodeCodeEditorFooterActionContext.js';
import { AiAssistEditorBase } from './custom/AiAssistEditorBase';

const genericCodeEditorAiAssistDefinition: CustomEditorDefinition<ChartNode> = {
  type: 'custom',
  customEditorId: 'GenericCodeEditorAiAssist',
  label: 'Generate Using AI',
};

function getLanguageInstruction(editor: CodeEditorDefinition<ChartNode>) {
  const language = editor.language.toLowerCase();
  const dataKey = String(editor.dataKey);

  if (dataKey === 'expression') {
    return 'Return only a single JavaScript expression. Do not return a function body, return statement, comments, or Markdown code fence.';
  }

  if (language.includes('javascript')) {
    return 'Return only raw JavaScript editor content. Do not wrap it in a Markdown code fence or add commentary.';
  }

  if (language.includes('json')) {
    return 'Return only raw JSON editor content. The result should be valid JSON when the request asks for JSON.';
  }

  if (language.includes('markdown')) {
    return 'Return only the raw Markdown/text content for the editor. Do not add commentary outside the requested content.';
  }

  return 'Return only the raw editor content. Do not wrap it in a Markdown code fence or add commentary.';
}

function getNodeTypeInstruction({
  dataKey,
  editorLabel,
  nodeType,
}: {
  dataKey: string;
  editorLabel: string;
  nodeType: string;
}) {
  switch (nodeType) {
    case 'codeNew':
      return 'Generate the body of a Rivet Code node async function. Return a value through the node output contract already expected by this editor.';
    case 'code':
      return 'Generate Code (legacy) node JavaScript that matches the existing input and output port names.';
    case 'expression':
      return 'Generate one JavaScript expression for the Expression node. Do not include return statements or function wrappers.';
    case 'object':
      return 'Generate an Object node JSON template. Keep Rivet interpolation tokens intact when they are relevant.';
    case 'prompt':
      return 'Generate a prompt template for a Prompt node. Preserve or add Rivet interpolation tokens only when they are useful.';
    case 'text':
      return 'Generate Text node content. Preserve or add Rivet interpolation tokens only when they are useful.';
    case 'comment':
      return 'Generate Markdown comment content for a canvas note.';
    case 'llmChatV2':
      return dataKey === 'extraProviderOptions'
        ? 'Generate provider option JSON for an LLM Chat node. Only include provider options that belong in the selected JSON field.'
        : 'Generate content for the selected LLM Chat node editor field.';
    case 'httpCall':
      return 'Generate JSON content for the selected HTTP Call node editor field.';
    case 'tool':
      return dataKey === 'schema'
        ? 'Generate a JSON Schema for a Tool node parameter object.'
        : 'Generate Tool node text content for the selected editor field.';
    case 'extractRegex':
      return 'Generate only the regular expression pattern for an Extract Regex node.';
    case 'extractObjectPath':
    case 'extractYaml':
      return 'Generate only the JSONPath expression for the selected extraction node field.';
    case 'jsFilter':
    case 'jsMap':
      return 'Generate JavaScript callback code for this list-processing node.';
    case 'join':
    case 'split':
    case 'userInput':
    case 'toTree':
    case 'chatLoop':
      return `Generate plain text for the ${editorLabel} field of this ${nodeType} node.`;
    default:
      return `Generate content appropriate for the ${editorLabel} field of this ${nodeType} node.`;
  }
}

function buildGenericEditorPrompt({
  editor,
  node,
  prompt,
  selectedText,
}: {
  editor: CodeEditorDefinition<ChartNode>;
  node: ChartNode;
  prompt: string;
  selectedText?: string;
}) {
  const data = node.data as Record<string, unknown>;
  const dataKey = String(editor.dataKey);
  const currentValue = typeof data[dataKey] === 'string' ? data[dataKey] : '';
  const editorLabel = editor.label.trim() || 'Code';
  const hasSelectedText = selectedText != null && selectedText.length > 0;

  return [
    'Generate content for a Rivet node settings editor.',
    '',
    `Node type: ${node.type}`,
    `Editor label: ${editorLabel}`,
    `Editor language: ${editor.language}`,
    `Editor data key: ${dataKey}`,
    '',
    'Rules:',
    '- Replace the editor content with the requested result.',
    hasSelectedText
      ? '- The selected editor content is the primary context. Use it as the part the user is asking about, but still return the final full editor content.'
      : '- Use the current editor content as context for the requested replacement.',
    '- Return only the final raw editor content.',
    '- Do not include explanations, introductions, or Markdown code fences.',
    `- ${getNodeTypeInstruction({ dataKey, editorLabel, nodeType: node.type })}`,
    `- ${getLanguageInstruction(editor)}`,
    '',
    '<current_editor_content>',
    currentValue,
    '</current_editor_content>',
    ...(hasSelectedText
      ? [
          '',
          '<selected_editor_content>',
          selectedText,
          '</selected_editor_content>',
        ]
      : []),
    '',
    '<user_request>',
    prompt,
    '</user_request>',
  ].join('\n');
}

export const CodeEditorAiAssistBridge: FC<{
  codeEditor: (footerLeftAction: ReactNode | null) => ReactNode;
  aiAssist: ReactNode;
}> = ({ codeEditor, aiAssist }) => {
  const [footerLeftAction, setFooterLeftAction] = useState<ReactNode | null>(null);
  const selectedTextGetter = useRef<() => string | undefined>();
  const footerActionBridge = useMemo(
    () => ({
      setFooterLeftAction,
      setSelectedTextGetter: (getter: (() => string | undefined) | undefined) => {
        selectedTextGetter.current = getter;
      },
      getSelectedText: () => selectedTextGetter.current?.(),
    }),
    [],
  );

  return (
    <div className="node-editor-code-ai-pair">
      <NodeCodeEditorFooterActionContext.Provider value={footerActionBridge}>
        {codeEditor(footerLeftAction)}
        {aiAssist}
      </NodeCodeEditorFooterActionContext.Provider>
    </div>
  );
};

export const GenericCodeEditorAiAssist: FC<
  Omit<SharedEditorProps, 'isDisabled'> & {
    codeEditor: CodeEditorDefinition<ChartNode>;
    isDisabled: boolean;
  }
> = ({ node, isReadonly, isDisabled, onChange, codeEditor }) => {
  const data = node.data as Record<string, unknown>;
  const dataKey = String(codeEditor.dataKey);
  const editorLabel = codeEditor.label.trim() || 'Code';

  return (
    <AiAssistEditorBase<Record<string, unknown>, { output: DataValue; response?: DataValue }>
      node={node}
      data={data}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      editor={genericCodeEditorAiAssistDefinition}
      onChange={onChange}
      graphName="Text Node Generator"
      placeholder={`What should Rivet generate for ${editorLabel}?`}
      label="Generate Using AI"
      collapsible
      defaultOpen={false}
      buildGeneratorPrompt={(prompt, context) =>
        buildGenericEditorPrompt({ editor: codeEditor, node, prompt, selectedText: context.selectedText })
      }
      updateData={(currentData, outputs) => {
        const output = coerceTypeOptional(outputs.output, 'string');

        return output == null ? null : { ...currentData, [dataKey]: output };
      }}
      getIsError={(outputs) => outputs.output == null || outputs.output.type === 'control-flow-excluded'}
      getErrorMessage={(outputs) => coerceTypeOptional(outputs.response, 'string') ?? 'Failed to generate content'}
      onSuccess={() => {
        toast.success(`${editorLabel} generated successfully!`);
      }}
    />
  );
};
