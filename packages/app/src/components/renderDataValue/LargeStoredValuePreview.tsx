import { css } from '@emotion/react';
import prettyBytes from 'pretty-bytes';
import { useEffect, useId, useMemo, useRef, useState, type FC } from 'react';
import { useDataRefs } from '../../providers/ProvidersContext.js';
import type { StoredDataValue } from '../../state/dataFlow.js';
import { FULL_RENDER_SAFE_THRESHOLD_CHARS } from '../../utils/outputStorageLimits.js';
import { tryRestoreStoredDataValue } from '../../utils/executionDataStorage.js';
import { copyToClipboard } from '../../utils/copyToClipboard.js';
import { handleError } from '../../utils/errorHandling.js';
import ColorizedPreformattedText from '../ColorizedPreformattedText.js';
import { FoldingCodeBlock } from './FoldingCodeBlock.js';
import { shouldShowLargeStoredValueActions, type OutputRenderMode } from './outputRenderTypes.js';
import { buildLargeStoredValueChunks, type LargeStoredValueChunk } from './largeStoredValueChunks.js';
import { deriveLargeStoredValuePreviewFullText } from './largeStoredValuePreviewText.js';
import { useLargeStoredValueFullscreenSearch } from './useLargeStoredValueFullscreenSearch.js';

const styles = css`
  display: block;

  > * + * {
    margin-top: 8px;
  }

  .preview-meta {
    color: var(--grey-lighter);
    font-size: var(--ui-font-size-xs);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .preview-actions {
    display: flex;
    gap: 8px;

    button {
      cursor: pointer;
      border: 1px solid var(--grey);
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      border-radius: 8px;
      corner-shape: squircle;
      @supports not (corner-shape: squircle) {
        border-radius: 4px;
      }
      padding: 4px 8px;
    }
  }

  .missing-ref {
    color: var(--warning);
    font-size: var(--ui-font-size-sm);
  }

  pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-preview-content pre {
    overflow-wrap: break-word;
    word-break: normal;
  }

  .fullscreen-output-body.wrap-lines & .json-preview-content pre {
    white-space: pre-wrap;
    overflow-wrap: break-word;
    word-break: normal;
  }

  .fullscreen-output-body.no-wrap-lines & pre {
    white-space: pre;
    overflow-wrap: normal;
    word-break: normal;
  }

  .chunk-pager {
    display: flex;
    align-items: center;
    gap: 8px;

    button {
      cursor: pointer;
      border: 1px solid var(--grey);
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      border-radius: 8px;
      corner-shape: squircle;
      @supports not (corner-shape: squircle) {
        border-radius: 4px;
      }
      width: 28px;
      height: 28px;
    }
  }

  .preview-content {
    min-height: 0;
  }
`;

export const LargeStoredValuePreview: FC<{
  value: Extract<StoredDataValue, { storage: 'ref' }>;
  mode: OutputRenderMode;
  allowLargeStoredValueActions?: boolean;
  wrapLines?: boolean;
}> = ({ value, mode, allowLargeStoredValueActions, wrapLines = true }) => {
  const dataRefs = useDataRefs();
  const [showFull, setShowFull] = useState(mode === 'full');
  const [chunkPage, setChunkPage] = useState(0);
  const preview = value.preview;
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rawProviderInstanceId = useId();
  const providerId = `large-stored-value-${value.refId}-${rawProviderInstanceId}`;

  useEffect(() => {
    setShowFull(mode === 'full');
    setChunkPage(0);
  }, [mode, value.refId]);

  const restoredValue = useMemo(
    () => (mode === 'compact' && !showFull ? undefined : tryRestoreStoredDataValue(value, dataRefs)),
    [dataRefs, mode, showFull, value],
  );

  const fullText = useMemo(() => deriveLargeStoredValuePreviewFullText(restoredValue), [restoredValue]);

  const shouldPageFullText = (fullText?.length ?? 0) > FULL_RENDER_SAFE_THRESHOLD_CHARS;
  const chunks = useMemo(() => (fullText ? buildLargeStoredValueChunks(fullText) : []), [fullText]);
  const activeChunk = useMemo((): LargeStoredValueChunk | undefined => {
    if (!fullText) {
      return undefined;
    }

    if (!showFull || !shouldPageFullText) {
      return (
        chunks[0] ?? {
          text: fullText,
          startOffset: 0,
          endOffset: fullText.length,
        }
      );
    }

    return chunks[chunkPage] ?? chunks[0];
  }, [chunkPage, chunks, fullText, shouldPageFullText, showFull]);

  const activeChunkText = useMemo(() => {
    if (!fullText) {
      return undefined;
    }

    if (!showFull) {
      return undefined;
    }

    if (!shouldPageFullText) {
      return fullText;
    }

    return activeChunk?.text ?? '';
  }, [activeChunk?.text, fullText, shouldPageFullText, showFull]);

  const chunkCount = shouldPageFullText ? Math.max(1, chunks.length) : 1;
  const showActions = shouldShowLargeStoredValueActions({ mode, allowLargeStoredValueActions });
  const missingRef = mode !== 'compact' && restoredValue == null;
  const usesFoldingJsonPreview = preview.kind === 'json' && showFull && !shouldPageFullText;
  const { providerRootProps, clearSearchAutoExpansion, activeMatchRange } = useLargeStoredValueFullscreenSearch({
    providerId,
    rootRef,
    contentRef,
    fullText,
    chunks,
    activeChunk,
    activeChunkText,
    shouldPageFullText,
    showFull,
    setShowFull,
    chunkPage,
    setChunkPage,
    highlightMode: usesFoldingJsonPreview ? 'external' : 'dom',
  });

  const handleCopyFullValue = () => {
    if (!fullText) {
      handleError(new Error('Value no longer available in memory'), 'Failed to copy node output');
      return;
    }

    void copyToClipboard(fullText);
  };

  const handleCopyJson = () => {
    if (!restoredValue) {
      handleError(new Error('Value no longer available in memory'), 'Failed to copy node output');
      return;
    }

    void copyToClipboard(JSON.stringify(restoredValue.value, null, 2));
  };

  const handleLoadFullValue = () => {
    clearSearchAutoExpansion();
    setShowFull(true);
  };

  return (
    <div ref={rootRef} css={styles} {...providerRootProps}>
      <div className="preview-meta">
        <span>{preview.kind === 'json' ? 'JSON Preview' : 'Text Preview'}</span>
        {'totalChars' in preview && <span>{preview.totalChars.toLocaleString()} chars</span>}
        {'lineCount' in preview && <span>{preview.lineCount.toLocaleString()} lines</span>}
        {'itemCount' in preview && preview.itemCount != null && <span>{preview.itemCount.toLocaleString()} items</span>}
        {'totalBytes' in preview && preview.totalBytes != null && <span>{prettyBytes(preview.totalBytes)}</span>}
        {'encodedHint' in preview && preview.encodedHint && <span>Likely {preview.encodedHint}</span>}
      </div>

      {showActions && (
        <div className="preview-actions">
          {!showFull && <button onClick={handleLoadFullValue}>Load Full Value</button>}
          <button onClick={handleCopyFullValue}>Copy Full Value</button>
          {preview.kind === 'json' && <button onClick={handleCopyJson}>Copy JSON</button>}
        </div>
      )}

      {missingRef ? (
        <div className="missing-ref">Value no longer available in memory.</div>
      ) : showFull && shouldPageFullText ? (
        <>
          <div className="chunk-pager">
            <button onClick={() => setChunkPage((current) => Math.max(0, current - 1))}>{'<'}</button>
            <span>
              {chunkPage + 1} / {chunkCount}
            </span>
            <button onClick={() => setChunkPage((current) => Math.min(chunkCount - 1, current + 1))}>{'>'}</button>
          </div>
          <div ref={contentRef} className="preview-content">
            {preview.kind === 'json' ? (
              <div className="json-preview-content">
                <ColorizedPreformattedText text={activeChunkText ?? ''} language="json" wrapWords />
              </div>
            ) : (
              <pre>{activeChunkText}</pre>
            )}
          </div>
        </>
      ) : preview.kind === 'json' && showFull ? (
        <div ref={contentRef} className="preview-content">
          <div className="json-preview-content">
            <FoldingCodeBlock
              text={activeChunkText ?? ''}
              language="json"
              wrapLines={wrapLines}
              searchProvider={false}
              activeMatchRange={activeMatchRange}
            />
          </div>
        </div>
      ) : (
        <div ref={contentRef} className="preview-content">
          <pre>{showFull ? activeChunkText : preview.kind === 'summary' ? preview.label : preview.excerpt}</pre>
        </div>
      )}
    </div>
  );
};
