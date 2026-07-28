import { Field } from '@atlaskit/form';
import { css } from '@emotion/react';
import { type ChartNode, type SegmentedEditorDefinition } from '@valerypopoff/rivet2-core';
import { type FC, useLayoutEffect, useRef, useState } from 'react';
import { FieldHelperMessage } from '../FieldHelperMessage.js';
import { type SharedEditorProps } from './SharedEditorProps';
import { getHelperMessage } from './editorUtils';

const segmentedEditorStyles = css`
  .segmented-editor-control {
    max-width: 100%;
    min-width: 0;
  }

  .segmented-choice {
    display: inline-flex;
    align-items: stretch;
    width: fit-content;
    max-width: 100%;
    min-height: calc(32px * var(--ui-font-scale));
    overflow: hidden;
    gap: calc(3px * var(--ui-font-scale));
    padding: calc(3px * var(--ui-font-scale));
    margin-left: -0.2em;
    box-sizing: border-box;
    background: var(--segmented-choice-bg);
    border: 0;
    border-radius: calc(32px * var(--ui-font-scale));
    corner-shape: superellipse(1.15);
    @supports not (corner-shape: squircle) {
      border-radius: calc(16px * var(--ui-font-scale));
    }
    box-shadow: none;
  }

  .segmented-choice[data-wrap='true'] {
    width: 100%;
    overflow: visible;
  }

  .segmented-choice-option {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 max-content;
    min-height: calc(24px * var(--ui-font-scale));
    padding: calc(4px * var(--ui-font-scale)) calc(12px * var(--ui-font-scale));
    box-sizing: border-box;
    border: 0;
    border-radius: calc(24px * var(--ui-font-scale));
    corner-shape: superellipse(1.15);
    @supports not (corner-shape: squircle) {
      border-radius: calc(12px * var(--ui-font-scale));
    }
    background: transparent;
    color: var(--grey-lightish);
    font: inherit;
    font-size: var(--ui-font-size-compact);
    font-weight: 700;
    line-height: 1.2;
    text-align: center;
    white-space: nowrap;
    overflow-wrap: normal;
    cursor: pointer;
    transition:
      background-color 0.14s ease-out,
      color 0.14s ease-out;
  }

  .segmented-choice[data-wrap='true'] .segmented-choice-option {
    flex: 1 1 0;
    min-width: 0;
    white-space: normal;
    overflow-wrap: break-word;
  }

  .segmented-choice-option:first-of-type {
    padding-left: calc(12px * var(--ui-font-scale));
  }

  .segmented-choice-option:last-of-type {
    padding-right: calc(12px * var(--ui-font-scale));
  }

  .segmented-choice-option:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--grey-light);
  }

  .segmented-choice-option.is-active {
    background: var(--primary);
    color: var(--foreground-on-primary);
    box-shadow: none;
  }

  .segmented-choice-option:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
`;

export const DefaultSegmentedEditor: FC<
  SharedEditorProps & {
    editor: SegmentedEditorDefinition<ChartNode>;
  }
> = ({ node, isReadonly, isDisabled, onChange, editor }) => {
  const data = node.data as Record<string, unknown>;
  const helperMessage = getHelperMessage(editor, node.data);

  return (
    <SegmentedEditor
      value={data[editor.dataKey] as string | boolean | undefined}
      isReadonly={isReadonly}
      isDisabled={isDisabled}
      onChange={(newValue) => {
        onChange({
          ...node,
          data: {
            ...data,
            [editor.dataKey]: newValue,
          },
        });
      }}
      label={editor.label}
      ariaLabel={editor.ariaLabel}
      name={editor.dataKey}
      helperMessage={helperMessage}
      options={editor.options}
      defaultValue={editor.defaultValue}
    />
  );
};

export const SegmentedEditor: FC<{
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
  isDisabled: boolean;
  isReadonly: boolean;
  label: string;
  ariaLabel?: string;
  name?: string;
  helperMessage?: string;
  options: readonly { label: string; value: string | boolean }[];
  defaultValue?: string | boolean;
  allowOptionWrap?: boolean;
}> = ({
  value,
  onChange,
  isReadonly,
  isDisabled,
  label,
  ariaLabel,
  name,
  helperMessage,
  options,
  defaultValue,
  allowOptionWrap = true,
}) => {
  const selectedValue = value ?? defaultValue ?? options[0]?.value;
  const disabled = isReadonly || isDisabled;
  const visibleLabel = label.trim() ? label : undefined;
  const effectiveAriaLabel = ariaLabel ?? visibleLabel ?? name ?? 'Segmented choice';
  const choiceRef = useRef<HTMLDivElement>(null);
  const [shouldWrap, setShouldWrap] = useState(false);

  useLayoutEffect(() => {
    const choice = choiceRef.current;

    if (!choice) {
      return;
    }

    let measureAnimationFrame = 0;
    let observedParentWidth = -1;
    const parent = choice.parentElement;

    const readAvailableWidth = () => parent?.getBoundingClientRect().width ?? choice.clientWidth;

    const measure = (availableWidth = readAvailableWidth()) => {
      cancelAnimationFrame(measureAnimationFrame);

      measureAnimationFrame = requestAnimationFrame(() => {
        if (availableWidth <= 0) {
          return;
        }

        choice.dataset.wrap = 'false';

        const wraps = allowOptionWrap && choice.scrollWidth > availableWidth + 1;
        choice.dataset.wrap = wraps ? 'true' : 'false';
        setShouldWrap(wraps);
      });
    };

    observedParentWidth = readAvailableWidth();
    measure(observedParentWidth);

    const resizeObserver = new ResizeObserver((entries) => {
      const availableWidth = entries[0]?.contentRect.width ?? readAvailableWidth();

      if (Math.abs(availableWidth - observedParentWidth) <= 0.5) {
        return;
      }

      observedParentWidth = availableWidth;
      measure(availableWidth);
    });

    if (parent) {
      resizeObserver.observe(parent);
    }

    return () => {
      cancelAnimationFrame(measureAnimationFrame);
      resizeObserver.disconnect();
    };
  }, [allowOptionWrap, options]);

  const control = (
    <div className="segmented-editor-control" css={segmentedEditorStyles}>
      {helperMessage && <FieldHelperMessage>{helperMessage}</FieldHelperMessage>}
      <div
        ref={choiceRef}
        className="segmented-choice"
        role="group"
        aria-label={effectiveAriaLabel}
        data-wrap={allowOptionWrap && shouldWrap ? 'true' : 'false'}
      >
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={`segmented-choice-option${option.value === selectedValue ? ' is-active' : ''}`}
            aria-pressed={option.value === selectedValue}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (!visibleLabel) {
    return <div className="segmented-editor-field">{control}</div>;
  }

  return (
    <Field name={name ?? visibleLabel} label={visibleLabel} isDisabled={disabled}>
      {() => control}
    </Field>
  );
};
