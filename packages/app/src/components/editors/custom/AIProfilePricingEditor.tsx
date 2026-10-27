import { css } from '@emotion/react';
import Button from '@atlaskit/button';
import {
  getChatV2SystemTokenPricing,
  getClassifierSystemTokenPricing,
  validateTokenPricing,
  type TokenPricing,
  type ChatV2Provider,
  type ClassifierTokenPricing,
} from '@valerypopoff/rivet2-core';
import type { FC } from 'react';
import { useNodeEditorDataChange, useNodeEditorSessionContext } from '../../nodeEditor/NodeEditorSessionContext.js';
import { NumberEditor } from '../NumberEditor.js';
import type { SharedEditorProps } from '../SharedEditorProps.js';

const fields = [
  ['inputPerMillionTokens', 'Input'],
  ['outputPerMillionTokens', 'Output'],
  ['cacheReadPerMillionTokens', 'Cached input (read)'],
  ['cacheWritePerMillionTokens', 'Cache write'],
] as const;
const styles = css`
  display: grid;
  gap: 8px;
  margin: 12px 0;
  .rates {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .system-rates {
    color: var(--foreground-dimmed);
    font-size: 12px;
  }
  button {
    justify-self: start;
  }
`;

export const AIProfilePricingEditor: FC<SharedEditorProps> = ({ node, onChange, isDisabled, isReadonly, onClose }) => {
  const data = node.data as {
    provider?: string;
    model?: string;
    useModelInput?: boolean;
    configurationMode?: 'inline' | 'profile';
    tokenPricing?: Partial<TokenPricing>;
  };
  const changeData = useNodeEditorDataChange(node, onChange);
  const session = useNodeEditorSessionContext();
  const locked = isDisabled || isReadonly;
  const isInlineNode = node.type === 'llmChatV2' || node.type === 'classifierEvaluate';
  const isDecision = node.type === 'classifierProfile' || node.type === 'classifierEvaluate';
  const readEditableData = () => {
    const current = (session?.getNode() ?? node).data as typeof data;
    return locked || (isInlineNode && current.configurationMode === 'profile') ? undefined : current;
  };
  if (isInlineNode && data.configurationMode === 'profile') return null;
  const system: (TokenPricing & Pick<ClassifierTokenPricing, 'longContext'>) | undefined = isDecision
    ? getClassifierSystemTokenPricing(data.provider, data.model)
    : getChatV2SystemTokenPricing((data.provider ?? 'openai') as ChatV2Provider, data.model ?? '');
  const systemOverride = system && {
    inputPerMillionTokens: system.inputPerMillionTokens,
    outputPerMillionTokens: system.outputPerMillionTokens,
  };
  let error: string | undefined;
  try {
    validateTokenPricing(data.tokenPricing);
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <div css={styles}>
      <div className="system-rates">
        Price overrides are optional. Leave them off to use reported costs or default rates when available; otherwise
        cost stays unknown.
      </div>
      <strong>USD / 1 million tokens</strong>
      <div className="system-rates" aria-label="Default token prices">
        Default rates:{' '}
        {fields
          .map(([key, label]) => `${label}: ${system?.[key] === undefined ? 'unknown' : `$${system[key]}`}`)
          .join(' · ')}
        {system?.longContext && (
          <div>
            Long context: above {system.longContext.aboveInputTokens} input tokens, input $
            {system.longContext.inputPerMillionTokens}, output ${system.longContext.outputPerMillionTokens}.
          </div>
        )}
        {data.provider === 'openrouter' && !isDecision && (
          <div>Without an override, uses the provider-reported dollar cost.</div>
        )}
        {data.useModelInput && (
          <div>Preview rates are for the configured model; the runtime input may select a different model.</div>
        )}
        {isDecision && (
          <div>
            Decision AI currently reports aggregate input/output tokens only; cache rates cannot apply without a
            reported breakdown.
          </div>
        )}
      </div>
      <label>
        <input
          type="checkbox"
          checked={data.tokenPricing !== undefined}
          disabled={locked}
          onChange={(event) => {
            if (readEditableData())
              changeData('tokenPricing', event.target.checked ? { ...systemOverride } : undefined);
          }}
        />{' '}
        Override token prices
      </label>
      {data.tokenPricing !== undefined && (
        <>
          <Button
            isDisabled={locked || !systemOverride}
            onClick={() => {
              if (readEditableData() && systemOverride) changeData('tokenPricing', systemOverride);
            }}
          >
            Use default rates
          </Button>
          <div className="rates">
            {fields.map(([key, label]) => (
              <NumberEditor
                key={key}
                label={`${label} USD / 1M tokens`}
                name={`token-pricing-${key}`}
                value={data.tokenPricing?.[key]}
                min={0}
                step={0.001}
                allowEmpty
                isDisabled={isDisabled}
                isReadonly={isReadonly}
                onClose={onClose}
                onChange={(value) => {
                  // Read the current owning node: batched edits must not replace
                  // another field or revive disabled/profile-owned inline pricing.
                  const current = readEditableData();
                  if (current?.tokenPricing === undefined) return;
                  const next = { ...current.tokenPricing };
                  if (value === undefined) delete next[key];
                  else next[key] = value;
                  changeData('tokenPricing', next);
                }}
              />
            ))}
          </div>
          {error && <div role="alert">{error}</div>}
          <div className="system-rates">
            Input and output rates are required. Blank cache rates use the input rate. Overrides take precedence over
            reported dollar cost and automatic long-context rates. Only provider-reported token usage is counted; past
            recordings are unchanged.
          </div>
        </>
      )}
    </div>
  );
};
