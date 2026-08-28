import TextField from '@atlaskit/textfield';

import type { useRuntimeLimitsForm } from '../useRuntimeLimitsForm';

export function ShellExecutionSettingsTab({ limits }: { limits: ReturnType<typeof useRuntimeLimitsForm> }) {
  return (
    <div className="project-settings-tab-panel app-settings-shell-execution-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Shell execution limits">
        <div className="app-settings-field-grid" aria-busy={limits.controlsDisabled}>
          <span className="app-settings-field-help">
            These limits apply only when the editor asks the server to run an allowed command, such as inspecting a
            project&apos;s Git history. They do not limit workflows, web apps, LLM calls, HTTP Call nodes, or endpoints.
          </span>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Command timeout</span>
            <TextField
              aria-label="Command timeout in seconds"
              type="number"
              min={1}
              value={limits.form.commandTimeoutSeconds}
              isDisabled={limits.controlsDisabled}
              elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
              onChange={(event) => {
                const value = event.currentTarget.value;
                limits.setForm((form) => ({ ...form, commandTimeoutSeconds: value }));
                limits.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">
              The server stops an allowed command after this much time. This usually affects Git history and revision
              comparison.
            </span>
          </label>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Maximum captured output</span>
            <TextField
              aria-label="Maximum captured output in MiB"
              type="number"
              min={1}
              value={limits.form.maxOutputMiB}
              isDisabled={limits.controlsDisabled}
              elemAfterInput={<span className="app-settings-input-suffix">MiB</span>}
              onChange={(event) => {
                const value = event.currentTarget.value;
                limits.setForm((form) => ({ ...form, maxOutputMiB: value }));
                limits.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">
              The server keeps at most this much text output from one command, protecting memory when a command prints
              too much.
            </span>
          </label>
        </div>
      </section>
    </div>
  );
}
