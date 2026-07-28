import { type FC, type ReactNode } from 'react';
import { DEFAULT_SPLIT_RUN_CONCURRENCY, isDataBusNode, type ChartNode } from '@valerypopoff/rivet2-core';
import TextField from '@atlaskit/textfield';
import Select from '@atlaskit/select';
import Button from '@atlaskit/button';
import { Tooltip } from '../Tooltip.js';
import { NodeMetadataEditor } from './NodeMetadataEditor.js';
import { LabeledToggle } from '../LabeledToggle.js';
import { SegmentedEditor } from '../editors/SegmentedEditor.js';
import GitBranchIcon from 'majesticons/line/git-branch-line.svg?react';
import type { NodeColor } from '../../utils/nodeColor.js';

type HeaderToggleFieldProps = {
  id: string;
  isChecked: boolean;
  onChange: (isChecked: boolean) => void;
  children: ReactNode;
  className?: string;
  isDisabled?: boolean;
};

const HeaderToggleField: FC<HeaderToggleFieldProps> = ({
  id,
  isChecked,
  onChange,
  children,
  className,
  isDisabled,
}) => (
  <LabeledToggle
    id={id}
    isChecked={isChecked}
    isDisabled={isDisabled}
    onChange={onChange}
    label={children}
    className={className ? `toggle-field ${className}` : 'toggle-field'}
  />
);

type SplitModeChoice = 'once' | 'parallel' | 'sequential';

const splitModeOptions: readonly { value: SplitModeChoice; label: string }[] = [
  { value: 'once', label: 'Run once' },
  { value: 'parallel', label: 'Many parallel runs' },
  { value: 'sequential', label: 'Many sequential runs' },
];

const splitModeHints: Record<SplitModeChoice, string> = {
  once: "Run the node once. If the input is an array, it's treated as a single input.",
  parallel: 'Run the node for each item in the array input. Runs are parallel.',
  sequential: 'Run the node for each item in the array input. Runs are sequential.',
};

function normalizePositiveInteger(value: number, min: number): number {
  return Math.max(min, Math.trunc(Number.isFinite(value) ? value : min));
}

const SplitModeChoiceControl: FC<{
  value: SplitModeChoice;
  onChange: (value: SplitModeChoice) => void;
  isDisabled?: boolean;
}> = ({ value, onChange, isDisabled = false }) => (
  <SegmentedEditor
    value={value}
    onChange={(nextValue) => onChange(nextValue as SplitModeChoice)}
    isReadonly={false}
    isDisabled={isDisabled}
    label=""
    ariaLabel="Run mode"
    options={splitModeOptions}
  />
);

const VariantsButton: FC<{
  onClick: () => void;
}> = ({ onClick }) => (
  <Tooltip content="Variants" tag="span" className="variants-tooltip">
    <button type="button" className="variants-button" aria-label="Variants" onClick={onClick}>
      <GitBranchIcon />
    </button>
  </Tooltip>
);

function getSplitMode(node: ChartNode): SplitModeChoice {
  if (!node.isSplitRun) {
    return 'once';
  }

  return node.isSplitSequential ? 'sequential' : 'parallel';
}

export const NodeEditorGlobalControls: FC<{
  node: ChartNode;
  selectedVariant: string | undefined;
  setSelectedVariant: (value: string | undefined) => void;
  addVariantPopupOpen: boolean;
  setAddVariantPopupOpen: (value: boolean) => void;
  variantOptions: { value: string; label: string }[];
  selectedVariantOption: { value: string; label: string } | undefined;
  onTitleChange: (title: string) => void;
  onDescriptionChange: (description: string) => void;
  onColorChange: (color: NodeColor | undefined) => void;
  onDisabledChange: (disabled: boolean) => void;
  onUpdateNode: (node: ChartNode) => void;
  onApplyVariant: () => void;
  onDeleteVariant: () => void;
  onSaveAsVariant: (id: string) => void;
}> = ({
  node,
  selectedVariant,
  setSelectedVariant,
  addVariantPopupOpen,
  setAddVariantPopupOpen,
  variantOptions,
  selectedVariantOption,
  onTitleChange,
  onDescriptionChange,
  onColorChange,
  onDisabledChange,
  onUpdateNode,
  onApplyVariant,
  onDeleteVariant,
  onSaveAsVariant,
}) => {
  const isVariant = selectedVariant !== undefined;
  const hasSavedVariants = variantOptions.length > 1;
  const isDataBus = isDataBusNode(node);
  const hasInvalidDataBusExecutionState =
    isDataBus && Boolean(node.disabled || node.isConditional || node.isSplitRun || (node.variants?.length ?? 0) > 0);
  const showVariantEditor = !isDataBus && (hasSavedVariants || addVariantPopupOpen);
  const showVariantsButton = !isDataBus && !hasSavedVariants;
  const nodeEnabledToggleId = `node-enabled-${node.id}`;
  const conditionalToggleId = `node-conditional-${node.id}`;
  const splitMode = getSplitMode(node);
  const showSplitRunFields = splitMode !== 'once';

  return (
    <div className="section section-global-controls">
      {!isDataBus && (
        <div className="node-type-row">
          <HeaderToggleField
            id={nodeEnabledToggleId}
            isChecked={!node.disabled}
            onChange={(isEnabled) => onDisabledChange(!isEnabled)}
          >
            <span>Active</span>
          </HeaderToggleField>
          <Tooltip
            className="node-type-tooltip"
            content="Exposes a conditional input port to the node, allowing to be executed only if the condition is met."
          >
            <HeaderToggleField
              id={conditionalToggleId}
              isChecked={node.isConditional ?? false}
              onChange={(isConditional) => onUpdateNode({ ...node, isConditional })}
            >
              <span>Conditional node</span>
            </HeaderToggleField>
          </Tooltip>
        </div>
      )}
      <NodeMetadataEditor
        node={node}
        onTitleChange={onTitleChange}
        onDescriptionChange={onDescriptionChange}
        onColorChange={onColorChange}
      />
      {hasInvalidDataBusExecutionState && (
        <div className="node-type-action">
          <Button
            appearance="subtle"
            onClick={() => {
              setSelectedVariant(undefined);
              setAddVariantPopupOpen(false);
              onUpdateNode({
                ...node,
                disabled: undefined,
                isConditional: undefined,
                isSplitRun: undefined,
                isSplitSequential: undefined,
                splitRunMax: undefined,
                splitRunConcurrency: undefined,
                variants: undefined,
              });
            }}
          >
            Repair Data Bus execution settings
          </Button>
        </div>
      )}
      <div className="node-options-row">
        <section className="split-controls">
          {!isDataBus && (
            <>
              <SplitModeChoiceControl
                value={splitMode}
                onChange={(nextSplitMode) =>
                  onUpdateNode({
                    ...node,
                    isSplitRun: nextSplitMode !== 'once',
                    isSplitSequential: nextSplitMode === 'sequential',
                  })
                }
              />
              <span className="split-mode-hint">{splitModeHints[splitMode]}</span>
            </>
          )}

          {!isDataBus && showSplitRunFields && (
            <div className="split-max">
              <div className="split-max-field">
                <label className="split-max-label">Max runs:</label>
                <TextField
                  className="split-max-input"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="Max"
                  value={node.splitRunMax ?? 10}
                  onChange={(event) => {
                    const rawValue = (event.target as HTMLInputElement).valueAsNumber;
                    const splitRunMax = normalizePositiveInteger(rawValue, 1);

                    onUpdateNode({
                      ...node,
                      splitRunMax,
                    });
                  }}
                />
              </div>
              {splitMode === 'parallel' && (
                <div className="split-max-field">
                  <label className="split-max-label">Max concurrent runs:</label>
                  <TextField
                    className="split-max-input"
                    type="number"
                    min={2}
                    step={1}
                    placeholder="Concurrent"
                    value={node.splitRunConcurrency ?? DEFAULT_SPLIT_RUN_CONCURRENCY}
                    onChange={(event) => {
                      const rawValue = (event.target as HTMLInputElement).valueAsNumber;
                      const splitRunConcurrency = normalizePositiveInteger(rawValue, 2);

                      onUpdateNode({
                        ...node,
                        splitRunConcurrency,
                      });
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </section>
        <section className="variants">
          {showVariantsButton && !showVariantEditor && (
            <VariantsButton onClick={() => setAddVariantPopupOpen(true)} />
          )}
        </section>
      </div>
      {showVariantEditor && (
        <div className="variant-editor-section">
          <div className="variant-editor-heading">Variants</div>
          <div className="variant-editor-row">
            {hasSavedVariants && (
              <Select
                className="variant-select"
                options={variantOptions}
                value={selectedVariantOption}
                onChange={(val) => setSelectedVariant(val!.value === '' ? undefined : val!.value)}
              />
            )}
            {isVariant ? (
              <div className="variant-buttons">
                <Button appearance="primary" onClick={onApplyVariant}>
                  Apply
                </Button>
                <Button appearance="danger" onClick={onDeleteVariant}>
                  Delete Variant
                </Button>
              </div>
            ) : (
              <TextField
                autoFocus
                className="variant-name-input"
                placeholder="Enter a name for the variant..."
                onBlur={() => {
                  if (!hasSavedVariants) {
                    setAddVariantPopupOpen(false);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onSaveAsVariant((event.target as HTMLInputElement).value);
                    setAddVariantPopupOpen(false);
                  }
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
