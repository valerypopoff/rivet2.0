import Button from '@atlaskit/button';
import TextField from '@atlaskit/textfield';
import DeleteIcon from 'majesticons/line/delete-bin-line.svg?react';
import EyeIcon from 'majesticons/line/eye-line.svg?react';
import EyeOffIcon from 'majesticons/line/eye-off-line.svg?react';
import { useEffect, useRef, useState } from 'react';

import { readEnvironmentVariableValue } from '../../appSettingsApi';
import type { EnvironmentVariableSettingsFormEntry } from '../model';
import type { useEnvironmentVariablesForm } from '../useEnvironmentVariablesForm';

function updateSet(current: ReadonlySet<string>, key: string, included: boolean): Set<string> {
  const next = new Set(current);
  if (included) {
    next.add(key);
  } else {
    next.delete(key);
  }
  return next;
}

export function EnvironmentVariablesSettingsTab({
  environmentVariables,
}: {
  environmentVariables: ReturnType<typeof useEnvironmentVariablesForm>;
}) {
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [revealErrors, setRevealErrors] = useState<Record<string, string>>({});
  const [revealLoading, setRevealLoading] = useState<ReadonlySet<string>>(new Set());
  const [visibleValues, setVisibleValues] = useState<ReadonlySet<string>>(new Set());
  const revealRequests = useRef(new Map<string, AbortController>());

  useEffect(() => {
    for (const request of revealRequests.current.values()) {
      request.abort();
    }
    revealRequests.current.clear();
    setRevealedValues({});
    setRevealErrors({});
    setRevealLoading(new Set());
    setVisibleValues(new Set());

    return () => {
      for (const request of revealRequests.current.values()) {
        request.abort();
      }
      revealRequests.current.clear();
    };
  }, [environmentVariables.baseline]);

  const clearRevealedValue = (key: string, hide: boolean) => {
    revealRequests.current.get(key)?.abort();
    revealRequests.current.delete(key);
    setRevealedValues((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRevealErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setRevealLoading((current) => updateSet(current, key, false));
    if (hide) {
      setVisibleValues((current) => updateSet(current, key, false));
    }
  };

  const update = (clientId: string, patch: Partial<EnvironmentVariableSettingsFormEntry>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'value')) {
      clearRevealedValue(clientId, false);
    }
    environmentVariables.setForm((form) => ({
      variables: form.variables.map((entry) => (entry.clientId === clientId ? { ...entry, ...patch } : entry)),
    }));
    environmentVariables.clearFeedback();
  };

  const toggleValueVisibility = async (entry: EnvironmentVariableSettingsFormEntry) => {
    const key = entry.clientId;
    if (visibleValues.has(key)) {
      clearRevealedValue(key, true);
      return;
    }

    if (!entry.id || entry.valueTouched) {
      setVisibleValues((current) => updateSet(current, key, true));
      return;
    }

    revealRequests.current.get(key)?.abort();
    const request = new AbortController();
    revealRequests.current.set(key, request);
    setRevealLoading((current) => updateSet(current, key, true));
    setRevealErrors((current) => ({ ...current, [key]: '' }));
    try {
      const revealed = await readEnvironmentVariableValue(entry.id, request.signal);
      if (revealRequests.current.get(key) !== request) {
        return;
      }
      setRevealedValues((current) => ({ ...current, [key]: revealed.value }));
      setVisibleValues((current) => updateSet(current, key, true));
    } catch (error) {
      if (request.signal.aborted || revealRequests.current.get(key) !== request) {
        return;
      }
      setRevealErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (revealRequests.current.get(key) === request) {
        revealRequests.current.delete(key);
        setRevealLoading((current) => updateSet(current, key, false));
      }
    }
  };

  return (
    <div className="project-settings-tab-panel app-settings-environment-variables-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Environment variables">
        <div className="app-settings-field-help">
          Variables saved here apply to Node executor, endpoint, and web-app runs immediately. They override the same
          names loaded from the deployment environment.
        </div>
        <div
          className="app-settings-environment-variables-table"
          role="table"
          aria-label="Environment variables"
          aria-busy={environmentVariables.controlsDisabled}
        >
          {environmentVariables.form.variables.length > 0 ? (
            <div className="app-settings-environment-variable-header" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Value</span>
              <span className="app-settings-environment-variable-browser-heading" role="columnheader">
                Browser
              </span>
              <span
                className="app-settings-environment-variable-actions-heading"
                role="columnheader"
                aria-label="Actions"
              />
            </div>
          ) : null}
          <div className="app-settings-environment-variables-list" role="rowgroup">
            {environmentVariables.form.variables.map((entry, index) => {
              const key = entry.clientId;
              const isVisible = visibleValues.has(key);
              const isLoading = revealLoading.has(key);
              const displayedValue = entry.valueTouched ? entry.value : revealedValues[key] ?? '';
              const displayName = entry.name.trim() || `variable ${index + 1}`;
              const visibilityLabel = isVisible ? `Hide value for ${displayName}` : `Show value for ${displayName}`;

              return (
                <div className="app-settings-environment-variable" role="row" key={key}>
                  <div className="app-settings-environment-variable-cell" role="cell" data-label="Name">
                    <TextField
                      aria-label={`Environment variable ${index + 1} name`}
                      value={entry.name}
                      isDisabled={environmentVariables.controlsDisabled}
                      placeholder="OPENAI_API_KEY"
                      onChange={(event) => update(key, { name: event.currentTarget.value })}
                    />
                  </div>
                  <div className="app-settings-environment-variable-value-cell" role="cell" data-label="Value">
                    <TextField
                      aria-label={`Environment variable ${index + 1} value`}
                      autoComplete="new-password"
                      type={isVisible || entry.valueTouched ? 'text' : 'password'}
                      value={displayedValue}
                      isDisabled={environmentVariables.controlsDisabled}
                      placeholder={entry.valueConfigured && !entry.valueTouched ? '••••••••' : 'Enter a value'}
                      elemAfterInput={
                        <Button
                          appearance="subtle"
                          spacing="compact"
                          className="app-settings-environment-variable-icon-button"
                          iconBefore={isVisible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
                          aria-label={isLoading ? `Loading value for ${displayName}` : visibilityLabel}
                          aria-pressed={isVisible}
                          title={visibilityLabel}
                          isDisabled={environmentVariables.controlsDisabled || isLoading}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => void toggleValueVisibility(entry)}
                        />
                      }
                      onChange={(event) =>
                        update(key, {
                          value: event.currentTarget.value,
                          valueTouched: true,
                        })
                      }
                    />
                    {revealErrors[key] ? (
                      <span className="project-settings-error app-settings-environment-variable-error" role="alert">
                        {revealErrors[key]}
                      </span>
                    ) : null}
                  </div>
                  <div className="app-settings-environment-variable-browser-cell" role="cell" data-label="Browser">
                    <input
                      aria-label={`Allow Browser executor access for ${displayName}`}
                      title="Allow Browser executor access"
                      type="checkbox"
                      checked={entry.browserAccess}
                      disabled={environmentVariables.controlsDisabled}
                      onChange={(event) =>
                        update(key, {
                          browserAccess: event.currentTarget.checked,
                        })
                      }
                    />
                  </div>
                  <div className="app-settings-environment-variable-actions-cell" role="cell" data-label="Actions">
                    <Button
                      appearance="subtle"
                      spacing="compact"
                      className="app-settings-environment-variable-icon-button"
                      iconBefore={<DeleteIcon aria-hidden="true" />}
                      aria-label={`Remove ${displayName}`}
                      title={`Remove ${displayName}`}
                      isDisabled={environmentVariables.controlsDisabled}
                      onClick={() => {
                        clearRevealedValue(key, true);
                        environmentVariables.remove(key);
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          {environmentVariables.form.variables.length === 0 ? (
            <div className="app-settings-field-help app-settings-environment-variables-empty">
              No UI-managed environment variables are configured.
            </div>
          ) : null}
        </div>
        <Button
          appearance="default"
          isDisabled={environmentVariables.controlsDisabled}
          onClick={() => {
            environmentVariables.add();
            environmentVariables.clearFeedback();
          }}
        >
          Add variable
        </Button>
      </section>
    </div>
  );
}
