import { ErrorMessage, Field, HelperMessage } from '@atlaskit/form';
import TextField from '@atlaskit/textfield';
import { css } from '@emotion/react';
import {
  getClassifierCredentialNamesForDisplay,
  isDefaultClassifierCredentialNames,
  isValidClassifierEnvironmentCredentialName,
  isValidClassifierProgrammaticCredentialName,
  classifierProviders,
  type ChartNode,
  type ClassifierCredentialNames,
  type CustomEditorDefinition,
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

type CredentialNameField = keyof ClassifierCredentialNames;
type ClassifierEvaluateCredentialData = {
  provider?: string;
  apiKeyNamesByProvider?: Record<string, ClassifierCredentialNames | undefined>;
  /** Compatibility for a node not yet normalized by an external caller. */
  apiKeyNames?: ClassifierCredentialNames;
};

export const ClassifierCredentialNamesEditor: FC<Props> = ({ node, onChange, isDisabled, isReadonly }) => {
  const data = node.data as ClassifierEvaluateCredentialData;
  // An older graph can name a provider this build no longer knows. Keep the
  // settings editor usable instead of letting an unavailable provider crash
  // the whole node-settings modal; processing still rejects that graph until
  // the author selects an installed provider.
  const provider = classifierProviders.find((candidate) => candidate.id === data.provider) ?? classifierProviders[0]!;
  const configuredNames = data.apiKeyNamesByProvider?.[provider.id] ?? data.apiKeyNames;
  const effectiveNames = getClassifierCredentialNamesForDisplay(configuredNames, provider.credentialNames);
  const [programmaticName, setProgrammaticName] = useState(effectiveNames.programmaticName);
  const [environmentVariableName, setEnvironmentVariableName] = useState(effectiveNames.environmentVariableName);
  const [programmaticError, setProgrammaticError] = useState<string>();
  const [environmentError, setEnvironmentError] = useState<string>();

  useEffect(() => {
    setProgrammaticName(effectiveNames.programmaticName);
    setEnvironmentVariableName(effectiveNames.environmentVariableName);
    setProgrammaticError(undefined);
    setEnvironmentError(undefined);
  }, [effectiveNames.environmentVariableName, effectiveNames.programmaticName, node.id, provider.id]);

  const commit = (field: CredentialNameField, rawValue: string) => {
    const value = rawValue.trim() || provider.credentialNames[field];
    const isValid =
      field === 'programmaticName'
        ? isValidClassifierProgrammaticCredentialName(value)
        : isValidClassifierEnvironmentCredentialName(value);
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
    const nextByProvider = { ...data.apiKeyNamesByProvider };
    if (isDefaultClassifierCredentialNames(nextNames, provider.credentialNames)) delete nextByProvider[provider.id];
    else nextByProvider[provider.id] = nextNames;
    const { apiKeyNames: _legacyApiKeyNames, apiKeyNamesByProvider: _previousByProvider, ...canonicalData } = data;
    onChange({
      ...node,
      data: {
        ...canonicalData,
        provider: provider.id,
        ...(Object.keys(nextByProvider).length > 0
          ? { apiKeyNamesByProvider: nextByProvider }
          : {}),
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
