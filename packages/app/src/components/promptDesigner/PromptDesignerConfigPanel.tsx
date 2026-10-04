import { type FC } from 'react';
import { Field } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import Button from '@atlaskit/button';
import Select from '@atlaskit/select';
import type { SetStateAction } from 'jotai';
import type { PromptDesignerConfigurationState } from '../../state/promptDesigner.js';
import { NumberEditor } from '../editors/NumberEditor.js';

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
  inProgress?: boolean;
}> = ({ config, setConfig, onRun, inProgress = false }) => {
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
                onChange={(value) =>
                  setConfig((state) => ({
                    ...state,
                    data: { ...state.data, provider: value!.value as typeof state.data.provider },
                  }))
                }
              />
            )}
          </Field>
          <Field name="model" label="Model">
            {({ fieldProps }) => (
              <TextField
                {...fieldProps}
                value={config.data.model}
                onChange={(event) => {
                  const model = event.currentTarget.value;
                  setConfig((state) => ({ ...state, data: { ...state.data, model } }));
                }}
              />
            )}
          </Field>
          <NumberEditor
            name="temperature"
            label="Temperature"
            value={config.data.temperature}
            min={0}
            step={0.1}
            allowEmpty
            isDisabled={false}
            isReadonly={false}
            onChange={(temperature) => setConfig((state) => ({ ...state, data: { ...state.data, temperature } }))}
          />
          <NumberEditor
            name="max-tokens"
            label="Max output tokens"
            value={config.data.maxTokens}
            min={1}
            isDisabled={false}
            isReadonly={false}
            onChange={(value) => {
              if (value !== undefined)
                setConfig((state) => ({ ...state, data: { ...state.data, maxTokens: Math.max(1, value) } }));
            }}
          />
          {config.data.provider === 'custom' && (
            <Field name="custom-base-url" label="Custom provider base URL">
              {({ fieldProps }) => (
                <TextField
                  {...fieldProps}
                  value={config.data.customProviderBaseURL}
                  onChange={(event) => {
                    const customProviderBaseURL = event.currentTarget.value;
                    setConfig((state) => ({ ...state, data: { ...state.data, customProviderBaseURL } }));
                  }}
                />
              )}
            </Field>
          )}
        </div>
        <div className="controls-buttons prompt-preview-run-controls">
          <Button appearance="primary" onClick={onRun} aria-busy={inProgress}>
            {inProgress ? 'Restart preview' : 'Run preview'}
          </Button>
          {inProgress && <span role="status">Preview running…</span>}
        </div>
      </div>
    </div>
  );
};
