import TextField from '@atlaskit/textfield';

import { defaultMaxRunsPerEndpoint, defaultRetentionDays, type RunRecordingsSettingsForm } from '../model';
import { ModeButton, ModeGroup, SettingsActions } from '../SettingsControls';
import type { useRunRecordingsForm } from '../useRunRecordingsForm';

export function RunRecordingsSettingsTab({ recordings }: { recordings: ReturnType<typeof useRunRecordingsForm> }) {
  const form = recordings.form;
  const update = <K extends keyof RunRecordingsSettingsForm>(key: K, value: RunRecordingsSettingsForm[K]) => {
    recordings.setForm((current) => ({ ...current, [key]: value }));
    recordings.clearFeedback();
  };

  return (
    <div className="project-settings-tab-panel app-settings-recordings-panel" role="tabpanel">
      <section className="app-settings-section" aria-label="Run recordings">
        <div className="app-settings-field-grid" aria-busy={recordings.controlsDisabled}>
          <label className="app-settings-field">
            <span className="app-settings-field-label">Queued recording writes</span>
            <TextField aria-label="Queued recording writes" type="number" min={0} value={form.maxPendingWrites} isDisabled={recordings.controlsDisabled} placeholder="100" onChange={(event) => update('maxPendingWrites', event.currentTarget.value)} />
            <span className="app-settings-field-help">How many recording save jobs can wait in memory before new recordings are skipped.</span>
          </label>

          <div className="app-settings-field">
            <span className="app-settings-field-label">Runs kept per workflow endpoint</span>
            <ModeGroup label="Runs kept per workflow endpoint mode">
              <ModeButton active={form.maxRunsPerEndpointMode === 'latest'} disabled={recordings.controlsDisabled} onClick={() => update('maxRunsPerEndpointMode', 'latest')}>Keep latest runs</ModeButton>
              <ModeButton active={form.maxRunsPerEndpointMode === 'all'} disabled={recordings.controlsDisabled} onClick={() => update('maxRunsPerEndpointMode', 'all')}>Keep all runs</ModeButton>
            </ModeGroup>
            {form.maxRunsPerEndpointMode === 'latest' ? (
              <TextField aria-label="Newest runs to keep per workflow endpoint" type="number" min={1} value={form.maxRunsPerEndpoint} isDisabled={recordings.controlsDisabled} placeholder={defaultMaxRunsPerEndpoint} onChange={(event) => update('maxRunsPerEndpoint', event.currentTarget.value)} />
            ) : null}
            <span className="app-settings-field-help">
              {form.maxRunsPerEndpointMode === 'latest'
                ? 'Keeping only the newest runs for each endpoint. Older runs are removed during cleanup.'
                : 'Keeping every recorded run for each endpoint.'}
            </span>
          </div>

          <div className="app-settings-field">
            <span className="app-settings-field-label">Days to keep recordings</span>
            <ModeGroup label="Recording retention mode">
              <ModeButton active={form.recordingRetentionMode === 'forever'} disabled={recordings.controlsDisabled} onClick={() => update('recordingRetentionMode', 'forever')}>Keep forever</ModeButton>
              <ModeButton active={form.recordingRetentionMode === 'limited'} disabled={recordings.controlsDisabled} onClick={() => update('recordingRetentionMode', 'limited')}>Keep for some time</ModeButton>
            </ModeGroup>
            {form.recordingRetentionMode === 'limited' ? (
              <TextField aria-label="Days to keep recordings" type="number" min={1} value={form.retentionDays} isDisabled={recordings.controlsDisabled} placeholder={defaultRetentionDays} onChange={(event) => update('retentionDays', event.currentTarget.value)} />
            ) : null}
            <span className="app-settings-field-help">
              {form.recordingRetentionMode === 'forever'
                ? 'Recordings are kept indefinitely unless another saved limit removes them.'
                : 'Recordings older than the selected number of days are removed during cleanup.'}
            </span>
          </div>
        </div>
        <SettingsActions
          changed={recordings.changed}
          disabled={recordings.controlsDisabled}
          error={recordings.error}
          loading={recordings.saving}
          onRevert={recordings.revert}
          onSave={recordings.save}
          saved={recordings.saved}
        />
      </section>
    </div>
  );
}
