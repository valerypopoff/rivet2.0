import { ErrorMessage, Field, HelperMessage } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { css } from '@emotion/react';
import {
  getChatV2DefaultCredentialNames,
  getChatV2CredentialNamesForDisplay,
  isChatV2BuiltInProvider,
  isDefaultChatV2CredentialNames,
  isValidChatV2EnvironmentCredentialName,
  isValidChatV2ProgrammaticCredentialName,
  type ChartNode,
  type ChatV2CredentialNames,
  type ChatV2CredentialNamesByProvider,
  type ChatV2BuiltInProvider,
  type CustomEditorDefinition,
  type LLMChatV2NodeData,
} from '@valerypopoff/rivet2-core';
import { type FC, useEffect, useState } from 'react';
import { type SharedEditorProps } from '../SharedEditorProps.js';

const styles = css`
  display: grid;
  gap: calc(12px * var(--ui-font-scale));
`;

type Props = SharedEditorProps & {
  editor: CustomEditorDefinition<ChartNode>;
};

type CredentialNameField = keyof ChatV2CredentialNames;

export const LLMChatV2CredentialNamesEditor: FC<Props> = ({ node, onChange, isDisabled, isReadonly }) => {
  const data = node.data as LLMChatV2NodeData;
  const provider = data.provider;
  if (!isChatV2BuiltInProvider(provider)) return null;

  return (
    <BuiltInCredentialNamesEditor
      node={node}
      data={data}
      provider={provider}
      onChange={onChange}
      isDisabled={isDisabled}
      isReadonly={isReadonly}
    />
  );
};

const BuiltInCredentialNamesEditor: FC<{
  node: ChartNode;
  data: LLMChatV2NodeData;
  provider: ChatV2BuiltInProvider;
  onChange: SharedEditorProps['onChange'];
  isDisabled: boolean;
  isReadonly: boolean;
}> = ({ node, data, provider, onChange, isDisabled, isReadonly }) => {
  const effectiveNames = getChatV2CredentialNamesForDisplay(provider, data.providerApiKeyNames?.[provider]);
  const [programmaticName, setProgrammaticName] = useState(effectiveNames.programmaticName);
  const [environmentVariableName, setEnvironmentVariableName] = useState(effectiveNames.environmentVariableName);
  const [programmaticError, setProgrammaticError] = useState<string>();
  const [environmentError, setEnvironmentError] = useState<string>();

  useEffect(() => {
    setProgrammaticName(effectiveNames.programmaticName);
    setEnvironmentVariableName(effectiveNames.environmentVariableName);
    setProgrammaticError(undefined);
    setEnvironmentError(undefined);
  }, [effectiveNames.environmentVariableName, effectiveNames.programmaticName, node.id, provider]);

  const commit = (field: CredentialNameField, rawValue: string) => {
    const defaults = getChatV2DefaultCredentialNames(provider);
    const value = rawValue.trim() || defaults[field];
    const isValid =
      field === 'programmaticName'
        ? isValidChatV2ProgrammaticCredentialName(value)
        : isValidChatV2EnvironmentCredentialName(value);
    const error = isValid
      ? undefined
      : field === 'programmaticName'
        ? 'Use a JavaScript-style identifier: letters, digits, _, or $, without a leading digit.'
        : 'Use a portable environment-variable name: letters, digits, and _, without a leading digit.';

    if (field === 'programmaticName') {
      setProgrammaticName(value);
      setProgrammaticError(error);
    } else {
      setEnvironmentVariableName(value);
      setEnvironmentError(error);
    }
    if (error) return;

    const nextNames = { ...effectiveNames, [field]: value };
    const nextNamesByProvider: ChatV2CredentialNamesByProvider = { ...data.providerApiKeyNames };
    if (isDefaultChatV2CredentialNames(provider, nextNames)) {
      delete nextNamesByProvider[provider];
    } else {
      nextNamesByProvider[provider] = nextNames;
    }

    onChange({
      ...node,
      data: {
        ...data,
        providerApiKeyNames: Object.keys(nextNamesByProvider).length === 0 ? undefined : nextNamesByProvider,
      },
    });
  };

  const disabled = isDisabled || isReadonly;
  return (
    <div css={styles}>
      <Field name="programmaticApiKeyName" label="Programmatic API key name" isDisabled={disabled}>
        {({ fieldProps }) => (
          <>
            <HelperMessage>Programmatic runs check this named processor setting first.</HelperMessage>
            <TextField
              {...fieldProps}
              value={programmaticName}
              isReadOnly={isReadonly}
              autoComplete="off"
              spellCheck={false}
              isInvalid={programmaticError != null}
              onChange={(event) => commit('programmaticName', event.currentTarget.value)}
            />
            {programmaticError && <ErrorMessage>{programmaticError}</ErrorMessage>}
          </>
        )}
      </Field>
      <Field name="apiKeyEnvironmentVariable" label="API key environment variable" isDisabled={disabled}>
        {({ fieldProps }) => (
          <>
            <HelperMessage>This environment variable is checked after the programmatic setting.</HelperMessage>
            <TextField
              {...fieldProps}
              value={environmentVariableName}
              isReadOnly={isReadonly}
              autoComplete="off"
              spellCheck={false}
              isInvalid={environmentError != null}
              onChange={(event) => commit('environmentVariableName', event.currentTarget.value)}
            />
            {environmentError && <ErrorMessage>{environmentError}</ErrorMessage>}
          </>
        )}
      </Field>
    </div>
  );
};
