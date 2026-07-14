import TextField from '@atlaskit/textfield';

import { SettingsActions } from '../SettingsControls';
import type { useRuntimeLimitsForm } from '../useRuntimeLimitsForm';

export function DockerSettingsTab({ limits }: { limits: ReturnType<typeof useRuntimeLimitsForm> }) {
  const showStatus = limits.status === 'docker' || limits.status === null;
  return (
    <div className="project-settings-tab-panel app-settings-docker-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Docker launcher">
        <div className="app-settings-field-grid" aria-busy={limits.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Startup wait timeout</span>
            <TextField
              aria-label="Docker startup wait timeout in seconds"
              type="number"
              min={1}
              value={limits.form.dockerWaitTimeoutSeconds}
              isDisabled={limits.controlsDisabled}
              elemAfterInput={<span className="app-settings-input-suffix">seconds</span>}
              onChange={(event) => {
                const value = event.currentTarget.value;
                limits.setForm((form) => ({ ...form, dockerWaitTimeoutSeconds: value }));
                limits.clearFeedback();
              }}
            />
            <span className="app-settings-field-help">How long npm Docker launchers wait for Compose services to become healthy. Kubernetes ignores this setting.</span>
          </label>
        </div>
        <SettingsActions
          changed={limits.changed.docker}
          disabled={limits.controlsDisabled}
          error={showStatus ? limits.error : null}
          loading={limits.saving && limits.status === 'docker'}
          onRevert={() => limits.revert('docker')}
          onSave={() => limits.save('docker')}
          saved={showStatus && limits.saved}
        />
      </section>
    </div>
  );
}
