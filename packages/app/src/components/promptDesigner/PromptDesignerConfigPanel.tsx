import { type FC } from 'react';
import { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import Select from '@atlaskit/select';
import type { SetStateAction } from 'jotai';
import type { PromptDesignerConfigurationState } from '../../state/promptDesigner.js';

const providerOptions = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'Google', value: 'google' },
  { label: 'Custom provider', value: 'custom' },
] as const;

/**
 * This deliberately exposes the small inline configuration surface that is
 * useful while iterating on a prompt. The preview uses LLM Chat V2 (not the
 * old private Chat runner); full profile behaviour belongs to the graph and
 * repeatable comparisons belong to Evaluations.
 */
export const PromptDesignerConfigPanel: FC<{
  config: PromptDesignerConfigurationState;
  setConfig: (update: SetStateAction<PromptDesignerConfigurationState>) => void;
  onRun: () => void;
}> = ({ config, setConfig, onRun }) => {
  const provider = providerOptions.find((option) => option.value === config.data.provider) ?? providerOptions[0];
  return (
    <div className="panel">
      <div className="chat-config-area">
        <div className="chat-config-controls">
          <Field name="provider" label="Provider">
            {({ fieldProps }) => (
              <Select
                {...fieldProps}
                options={providerOptions as unknown as { label: string; value: string }[]}
                value={provider}
                onChange={(value) => setConfig((state) => ({
                  ...state,
                  data: { ...state.data, provider: value!.value as typeof state.data.provider },
                }))}
              />
            )}
          </Field>
          <Field name="model" label="Model">
            {({ fieldProps }) => (
              <TextField
                {...fieldProps}
                value={config.data.model}
                onChange={(event) => setConfig((state) => ({ ...state, data: { ...state.data, model: event.currentTarget.value } }))}
              />
            )}
          </Field>
          <Field name="temperature" label="Temperature">
            {({ fieldProps }) => (
              <TextField
                {...fieldProps}
                type="number"
                value={String(config.data.temperature)}
                min={0}
                step={0.1}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) setConfig((state) => ({ ...state, data: { ...state.data, temperature: value } }));
                }}
              />
            )}
          </Field>
          <Field name="max-tokens" label="Max output tokens">
            {({ fieldProps }) => (
              <TextField
                {...fieldProps}
                type="number"
                value={String(config.data.maxTokens)}
                min={1}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) setConfig((state) => ({ ...state, data: { ...state.data, maxTokens: Math.max(1, value) } }));
                }}
              />
            )}
          </Field>
          {config.data.provider === 'custom' && (
            <Field name="custom-base-url" label="Custom provider base URL">
              {({ fieldProps }) => (
                <TextField
                  {...fieldProps}
                  value={config.data.customProviderBaseURL}
                  onChange={(event) => setConfig((state) => ({ ...state, data: { ...state.data, customProviderBaseURL: event.currentTarget.value } }))}
                />
              )}
            </Field>
          )}
        </div>
        <div className="controls-buttons">
          <Button appearance="primary" onClick={onRun}>Run preview</Button>
        </div>
      </div>
    </div>
  );
};
