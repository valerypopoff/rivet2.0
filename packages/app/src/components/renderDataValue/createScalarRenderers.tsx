import { useMarkdown } from '../../hooks/useMarkdown.js';
import {
  type AudioDataValue,
  type BinaryDataValue,
  type ChatMessageDataValue,
  type ChatMessageMessagePart,
  type DataType,
  type DocumentDataValue,
  type ImageDataValue,
  inferType,
  type ScalarDataType,
  type ScalarDataValue,
} from '@valerypopoff/rivet2-core';
import prettyBytes from 'pretty-bytes';
import { useMemo, type FC } from 'react';
import { match } from 'ts-pattern';
import type { DataValueRendererProps } from './createDataValueRendererMap.js';
import ColorizedPreformattedText from '../ColorizedPreformattedText.js';
import { FoldingCodeBlock } from './FoldingCodeBlock.js';
import { RenderChatMessagePart } from './RenderChatMessagePart.js';
import { COMPACT_PREVIEW_MAX_CHARS, COMPACT_PREVIEW_MAX_LINES } from '../../utils/outputStorageLimits.js';
import { getRenderedStringText } from './stringPreview.js';
import { buildTextPreviewExcerpt } from '../../utils/textPreview.js';
import { getFunctionResponseDisplayLabel, getRenderableAssistantFunctionCall } from './chatMessageRenderUtils.js';
import {
  getByteLength,
  getMediaData,
  getMediaType,
  getStringProperty,
  isRecord,
  stringifyForDisplay,
  stringifyUninferredAnyValue,
} from '../../utils/dataValuePayloads.js';

export type ScalarRendererProps<T extends DataType = DataType> = {
  value: Extract<ScalarDataValue, { type: T }>;
  depth?: number;
  renderMarkdown?: boolean;
  truncateLength?: number;
  isCompact?: boolean;
  mode?: DataValueRendererProps['mode'];
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
};

export function createScalarRenderers(options: { renderValue: (props: DataValueRendererProps) => JSX.Element }) {
  const { renderValue } = options;

  /* eslint-disable react-hooks/rules-of-hooks -- table-driven renderers */
  const scalarRenderers: {
    [P in ScalarDataType]: FC<ScalarRendererProps<P>>;
  } = {
    boolean: ({ value }) => <>{value.value ? 'true' : 'false'}</>,
    number: ({ value }) => <>{value.value}</>,
    string: ({ value, renderMarkdown, truncateLength, isCompact }) => {
      const truncated = getRenderedStringText(value.value, { truncateLength, isCompact });

      const markdownEnabled = !!renderMarkdown && !isCompact;
      const markdownRendered = useMarkdown(truncated, markdownEnabled);

      if (markdownEnabled) {
        return <div className="markdown-body rivet-markdown-output" dangerouslySetInnerHTML={markdownRendered} />;
      }

      return <pre className="pre-wrap">{truncated}</pre>;
    },
    'chat-message': ({ value, renderMarkdown, isCompact, allowLargeStoredValueActions, wrapLines }) => {
      const { value: realValue } = value as ChatMessageDataValue;
      let parts = getRenderableChatMessageParts(isRecord(realValue) ? realValue.message : undefined);

      if (isCompact && parts.length > 1) {
        parts = parts.slice(0, 1);
      }

      const renderString = (part: string) => {
        const Renderer = scalarRenderers.string;
        return (
          <Renderer value={{ type: 'string', value: part }} renderMarkdown={renderMarkdown} isCompact={isCompact} />
        );
      };

      const messageContent = (
        <div className="message-content">
          {parts.map((part: ChatMessageMessagePart, index) => (
            <div className="chat-message-message-part" key={index}>
              <RenderChatMessagePart part={part} renderString={renderString} />
            </div>
          ))}
        </div>
      );

      return match(realValue)
        .with({ type: 'system' }, () => (
          <div className="chat-message system">
            <header>
              <em>system</em>
            </header>
            {messageContent}
          </div>
        ))
        .with({ type: 'user' }, () => (
          <div className="chat-message user">
            <header>
              <em>user</em>
            </header>
            {messageContent}
          </div>
        ))
        .with({ type: 'assistant' }, (message) => {
          const functionCall = getRenderableAssistantFunctionCall(message);

          return (
            <div className="chat-message assistant">
              <header>
                <em>assistant</em>
              </header>
              {messageContent}
              {functionCall?.type === 'multiple' ? (
                <div className="function-calls">
                  <h4>Function Calls:</h4>
                  <div className="pre-wrap">
                    {functionCall.functionCalls.map((fc, index) => (
                      <div key={index}>
                        {renderValue({ value: inferType(fc), allowLargeStoredValueActions, wrapLines })}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                functionCall?.type === 'single' && (
                  <div className="function-call">
                    <h4>Function Call:</h4>
                    <div className="pre-wrap">
                      {renderValue({
                        value: inferType(functionCall.functionCall),
                        allowLargeStoredValueActions,
                        wrapLines,
                      })}
                    </div>
                  </div>
                )
              )}
            </div>
          );
        })
        .with({ type: 'function' }, (message) => (
          <div className="chat-message function">
            <header>
              <em>function output for: {getFunctionResponseDisplayLabel(message)}</em>
            </header>
            {messageContent}
          </div>
        ))
        .otherwise(() => (
          <div className="chat-message unknown">
            <header>
              <em>unknown</em>
            </header>
            {messageContent}
          </div>
        ));
    },
    date: ({ value }) => <>{value.value}</>,
    time: ({ value }) => <>{value.value}</>,
    datetime: ({ value }) => <>{value.value}</>,
    'control-flow-excluded': () => <>Not ran</>,
    any: ({
      value,
      depth,
      renderMarkdown,
      isCompact,
      mode,
      truncateLength,
      allowLargeStoredValueActions,
      wrapLines,
    }) => {
      const inferred = inferType(value.value);
      if (inferred.type === 'any') {
        return <>{stringifyUninferredAnyValue(inferred.value)}</>;
      }
      return renderValue({
        value: inferred,
        depth: (depth ?? 0) + 1,
        renderMarkdown,
        isCompact,
        mode,
        truncateLength,
        allowLargeStoredValueActions,
        wrapLines,
      });
    },
    object: ({ value, isCompact, mode, allowLargeStoredValueActions, wrapLines }) => {
      let stringified = stringifyForDisplay(value.value);

      if (isCompact) {
        stringified = buildTextPreviewExcerpt(stringified, {
          maxChars: COMPACT_PREVIEW_MAX_CHARS,
          maxLines: COMPACT_PREVIEW_MAX_LINES,
        }).text;
        return <pre className="pre-wrap">{stringified}</pre>;
      }

      if (shouldUseFullscreenFoldingOutput({ mode, allowLargeStoredValueActions })) {
        return (
          <div className="rendered-object-type">
            <FoldingCodeBlock text={stringified} language="json" wrapLines={wrapLines ?? true} />
          </div>
        );
      }

      return (
        <div className="rendered-object-type">
          <ColorizedPreformattedText text={stringified} language="json" wrapWords />
        </div>
      );
    },
    'gpt-function': ({ value }) => (
      <>
        GPT Function: <em>{getStringProperty(value.value, 'name') ?? 'unknown'}</em>
      </>
    ),
    vector: ({ value }) => <>Vector (length {Array.isArray(value.value) ? value.value.length : 0})</>,
    image: ({ value }) => {
      const imageValue = value as ImageDataValue;
      const imageData = getMediaData(imageValue.value);
      const mediaType = getMediaType(imageValue.value);
      const imageUrl = useMemo(() => {
        if (!imageData) {
          return undefined;
        }

        const blob = new Blob([imageData], { type: mediaType });
        return URL.createObjectURL(blob);
      }, [imageData, mediaType]);

      if (!imageUrl) {
        return <>Invalid image value</>;
      }

      return (
        <div>
          <img src={imageUrl} alt="" />
        </div>
      );
    },
    binary: ({ value }) => {
      const binaryValue = value as BinaryDataValue;
      return <>Binary (length {getByteLength(binaryValue.value).toLocaleString()})</>;
    },
    audio: ({ value }) => {
      const audioValue = value as AudioDataValue;
      const audioData = getMediaData(audioValue.value);
      const mediaType = getMediaType(audioValue.value);
      const dataUri = useMemo(() => {
        if (!audioData) {
          return undefined;
        }

        const blob = new Blob([audioData], { type: mediaType });
        return URL.createObjectURL(blob);
      }, [audioData, mediaType]);

      if (!dataUri) {
        return <>Invalid audio value</>;
      }

      return (
        <div>
          <audio controls>
            <source src={dataUri} />
          </audio>
        </div>
      );
    },
    'graph-reference': ({ value }) => {
      return (
        <div>(Reference to graph &quot;{getStringProperty(value.value, 'graphName') ?? 'unknown graph'}&quot;)</div>
      );
    },
    'knowledge-source': ({ value }) => (
      <div>
        Knowledge source <em>{value.value.sourceId}</em> in <em>{value.value.connectionId}</em>
        {value.value.version ? ` (${value.value.version})` : ' (active version)'}
      </div>
    ),
    'knowledge-document': ({ value, isCompact }) => {
      const text = isCompact
        ? buildTextPreviewExcerpt(value.value.text, {
            maxChars: COMPACT_PREVIEW_MAX_CHARS,
            maxLines: COMPACT_PREVIEW_MAX_LINES,
          }).text
        : value.value.text;
      return (
        <div>
          <strong>{value.value.title || value.value.id || 'Knowledge document'}</strong>
          <pre className="pre-wrap">{text}</pre>
        </div>
      );
    },
    'knowledge-evidence': ({ value, isCompact }) => {
      const text = isCompact
        ? buildTextPreviewExcerpt(value.value.text, {
            maxChars: COMPACT_PREVIEW_MAX_CHARS,
            maxLines: COMPACT_PREVIEW_MAX_LINES,
          }).text
        : value.value.text;
      return (
        <div>
          <strong>{value.value.title || value.value.documentId}</strong>
          {value.value.relevanceScore != null && <div>Score: {value.value.relevanceScore}</div>}
          <pre className="pre-wrap">{text}</pre>
        </div>
      );
    },
    'llm-config': ({ value }) => {
      const { configuration, credential } = value.value;
      return (
        <div>
          LLM profile: <em>{configuration.provider}</em> / <em>{configuration.model}</em>
          <div>API key source: {credential.reference.source}</div>
        </div>
      );
    },
    document: ({ value }) => {
      const documentValue = value as DocumentDataValue;
      const documentData = getMediaData(documentValue.value);
      const mediaType = getMediaType(documentValue.value) ?? 'unknown media type';
      const title = getStringProperty(documentValue.value, 'title');
      const context = getStringProperty(documentValue.value, 'context');
      const enableCitations = isRecord(documentValue.value) && documentValue.value.enableCitations === true;
      const dataLength = getByteLength(documentData);

      return (
        <div>
          <p>
            {title ? `Document: ${title}` : 'Document'} ({mediaType})
          </p>
          {context && <p>{context}</p>}
          {enableCitations && <p>(Citations enabled)</p>}
          Size: {dataLength > 0 ? prettyBytes(dataLength) : '0 bytes'}
        </div>
      );
    },
  };
  /* eslint-enable react-hooks/rules-of-hooks -- table-driven renderers */

  return scalarRenderers;
}

function getRenderableChatMessageParts(value: unknown): ChatMessageMessagePart[] {
  const parts = Array.isArray(value) ? value : [value];
  const renderableParts = parts.filter(isRenderableChatMessagePart);
  return renderableParts.length > 0 ? renderableParts : [''];
}

function shouldUseFullscreenFoldingOutput({
  mode,
  allowLargeStoredValueActions,
}: {
  mode?: DataValueRendererProps['mode'];
  allowLargeStoredValueActions?: boolean;
}): boolean {
  return mode === 'expanded-preview' && allowLargeStoredValueActions === true;
}

function isRenderableChatMessagePart(part: unknown): part is ChatMessageMessagePart {
  if (typeof part === 'string') {
    return true;
  }

  if (!isRecord(part)) {
    return false;
  }

  if (part.type === 'url') {
    return typeof part.url === 'string';
  }

  if (part.type === 'image' || part.type === 'document') {
    return getMediaData(part) != null;
  }

  return false;
}
