import Button from '@atlaskit/button';
import ModalDialog, { ModalBody, ModalTransition } from '@atlaskit/modal-dialog';
import { useEffect, useState, type FC } from 'react';
import { RIVET_API_BASE_URL } from '../../studio-server-shared/hosted-env';
import './LocalStorageUpgradePrompt.css';

type UpgradeStatus = {
  available: boolean;
  operation?: string | null;
  runningBackend: string;
  maintenance: unknown | null;
  restartRequired: boolean;
  transition: { phase: string; backend: string; canReturnToLegacy?: boolean } | null;
};

type SetupStatus = {
  eligible: boolean;
  upgradeEnabled: boolean;
  controlRootConfigured: boolean;
  encryptionKeyReady: boolean;
  sqliteSelected: boolean;
  liveSqlite: boolean;
};

type Prompt =
  | { kind: 'setup'; setup: SetupStatus }
  | { kind: 'offer' }
  | { kind: 'in-progress'; phase: string; canReturnToLegacy: boolean };

function pendingPrompt(status: UpgradeStatus): Prompt | null {
  if (!status.available || !status.transition) return null;
  const { phase, backend, canReturnToLegacy } = status.transition;
  if (
    !['legacy', 'legacy-resumed', 'verified', 'sqlite-validation', 'legacy-validation', 'sqlite-live'].includes(phase)
  )
    return null;
  if (
    phase === 'sqlite-live' &&
    backend === 'sqlite' &&
    status.runningBackend === 'sqlite' &&
    !status.maintenance &&
    !status.restartRequired
  )
    return null;
  if (
    (phase === 'legacy' || phase === 'legacy-resumed') &&
    backend === 'legacy' &&
    status.runningBackend === 'legacy' &&
    !status.maintenance &&
    !status.operation &&
    !status.restartRequired
  )
    return { kind: 'offer' };
  return {
    kind: 'in-progress',
    phase,
    canReturnToLegacy:
      !!canReturnToLegacy || ((phase === 'legacy' || phase === 'legacy-resumed') && !!status.maintenance),
  };
}

// A dashboard remount within the same SPA page is not a page reload.
let dismissedForThisPage = false;

export const LocalStorageUpgradePrompt: FC<{
  suppressed: boolean;
  onStart: () => void;
}> = ({ suppressed, onStart }) => {
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  useEffect(() => {
    // The operator can change the durable phase in Settings without reloading
    // the page. Discard the old prompt while another modal is open, then read
    // fresh status when it closes instead of offering stale recovery actions.
    if (suppressed || dismissedForThisPage) {
      setPrompt(null);
      return;
    }
    const controller = new AbortController();
    let retryTimer: number | undefined;
    const readStatus = async () => {
      if (controller.signal.aborted || dismissedForThisPage) return;
      try {
        const setupResponse = await fetch(`${RIVET_API_BASE_URL}/app-settings/local-upgrade/setup`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!setupResponse.ok) {
          if (!controller.signal.aborted) setPrompt(null);
          if (setupResponse.status >= 500) retryTimer = window.setTimeout(() => void readStatus(), 3000);
          return;
        }
        const setup = (await setupResponse.json()) as SetupStatus;
        if (!setup.eligible || setup.liveSqlite) {
          if (!controller.signal.aborted) setPrompt(null);
          return;
        }
        if (!setup.upgradeEnabled || !setup.controlRootConfigured || !setup.encryptionKeyReady) {
          if (!controller.signal.aborted && !dismissedForThisPage) {
            setPrompt({ kind: 'setup', setup });
            retryTimer = window.setTimeout(() => void readStatus(), 10_000);
          }
          return;
        }
        const response = await fetch(`${RIVET_API_BASE_URL}/app-settings/local-upgrade`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        // This endpoint is operator-only. Disabled deployments and ordinary
        // users must not receive a prompt or any upgrade information.
        if (!response.ok) {
          if (!controller.signal.aborted) setPrompt(null);
          if (response.status >= 500) retryTimer = window.setTimeout(() => void readStatus(), 3000);
          return;
        }
        const status = (await response.json()) as UpgradeStatus;
        if (!controller.signal.aborted && !dismissedForThisPage) {
          const next = pendingPrompt(status);
          setPrompt(next);
          // Another operator may finish the upgrade or revoke this session
          // while the reminder is open. Never keep offering stale recovery.
          if (next) retryTimer = window.setTimeout(() => void readStatus(), 10_000);
        }
      } catch {
        // A temporary connection failure cannot authorize an upgrade, but it
        // should not lose this page-load reminder until the next reload.
        if (!controller.signal.aborted) {
          setPrompt(null);
          retryTimer = window.setTimeout(() => void readStatus(), 3000);
        }
      }
    };
    void readStatus();
    return () => {
      controller.abort();
      window.clearTimeout(retryTimer);
    };
  }, [suppressed]);

  const dismiss = () => {
    dismissedForThisPage = true;
    setPrompt(null);
  };
  return (
    <ModalTransition>
      {prompt && !suppressed ? (
        <ModalDialog
          testId="local-storage-upgrade-prompt"
          width="medium"
          label="Local storage upgrade"
          onClose={dismiss}
        >
          <ModalBody>
            <div className="local-storage-upgrade-prompt">
              {prompt.kind === 'setup' && prompt.setup.sqliteSelected ? (
                <>
                  <h2>Restore paused SQLite upgrade controls</h2>
                  <p>
                    SQLite is already selected, but writes are still paused. Restore the original deployment environment
                    values for <code>RIVET_LOCAL_METADATA_ENCRYPTION_KEY</code> and{' '}
                    <code>RIVET_LOCAL_METADATA_CONTROL_ROOT</code>, then set{' '}
                    <code>RIVET_LOCAL_METADATA_UPGRADE_ENABLED=1</code> and recreate the combined backend. These are
                    server startup variables, not Rivet’s Environment variables Settings tab.
                  </p>
                  <p>
                    Do not generate a new key, reset the control volume or run provisioning again. Once the backend is
                    available, continue paused validation or return to legacy. If it cannot start, use the documented
                    offline recovery procedure; never clear the maintenance marker by hand.
                  </p>
                </>
              ) : prompt.kind === 'setup' ? (
                <>
                  <h2>Prepare the local storage upgrade</h2>
                  <p>
                    Before starting the migration, a deployment administrator must configure the VM. These are server
                    startup variables in its protected deployment environment, not entries in Rivet’s Environment
                    variables Settings tab. Do not enter the encryption key in this browser.
                  </p>
                  <ul>
                    <li>
                      Set <code>RIVET_LOCAL_METADATA_ENCRYPTION_KEY</code> to a dedicated, securely generated secret of
                      at least 32 characters, and keep a separate protected backup. If this VM has already started an
                      upgrade, restore its original key; never replace it with a new one.{' '}
                      {prompt.setup.encryptionKeyReady ? 'Configured.' : 'Not configured yet.'}
                    </li>
                    <li>
                      Use the persistent <code>rivet_local_metadata</code> volume and configure{' '}
                      <code>RIVET_LOCAL_METADATA_CONTROL_ROOT=/data/local-metadata</code>. On a fresh control volume
                      only, stop the backend and run the one-time <code>local-metadata-control --provision</code>{' '}
                      command using that volume and root. Never reset or re-provision an existing upgrade. Do not start
                      the normal backend with a new root until provisioning succeeds.{' '}
                      {prompt.setup.controlRootConfigured ? 'Root configured.' : 'Root not configured yet.'}
                    </li>
                    <li>
                      Set <code>RIVET_LOCAL_METADATA_UPGRADE_ENABLED=1</code> and recreate the backend using the normal
                      launcher; restarting an existing container does not load changed environment values.{' '}
                      {prompt.setup.upgradeEnabled ? 'Enabled.' : 'Not enabled yet.'}
                    </li>
                  </ul>
                  <p>
                    This setup does not move data. The guided upgrade will still require a paused source, an
                    independently restored backup and matching fingerprint, exact copy verification, runtime validation
                    and explicit write resumption. Rehearse on a restored copy before production.
                  </p>
                </>
              ) : prompt.kind === 'offer' ? (
                <>
                  <h2>Local storage upgrade available</h2>
                  <p>
                    This server still uses the older file-backed metadata layout. The guided upgrade copies that
                    metadata into SQLite and verifies it before switching. Your original files stay intact.
                  </p>
                  <p>
                    You can postpone and keep using the current layout. This reminder will appear again after the next
                    page reload. Review the backup and recovery steps before starting.
                  </p>
                </>
              ) : (
                <>
                  <h2>
                    {prompt.phase === 'legacy-validation' ? 'Complete storage recovery' : 'Storage upgrade in progress'}
                  </h2>
                  <p>
                    The upgrade has not finished. Open the guided workflow to check its durable status and continue
                    safely. This reminder will return after every page reload until SQLite is live or legacy recovery is
                    complete.
                  </p>
                  {prompt.canReturnToLegacy ? (
                    <p>
                      {prompt.phase === 'legacy' || prompt.phase === 'legacy-resumed'
                        ? 'You can cancel the upgrade and resume unchanged legacy storage from the Recovery section.'
                        : 'You can still return to the old file-backed mode in the Recovery section while writes are paused.'}
                    </p>
                  ) : prompt.phase === 'sqlite-live' ? (
                    <p>
                      SQLite write resumption has closed one-click rollback. Finish the required restart or recover from
                      a coordinated backup; do not switch back to stale files.
                    </p>
                  ) : prompt.phase === 'legacy-validation' ? (
                    <p>Legacy recovery is selected. Restart, validate the legacy runtime, then resume writes.</p>
                  ) : null}
                </>
              )}
              <div className="local-storage-upgrade-prompt-actions">
                {prompt.kind !== 'setup' && (
                  <Button
                    appearance="primary"
                    onClick={() => {
                      dismiss();
                      onStart();
                    }}
                  >
                    {prompt.kind === 'offer' ? 'Review upgrade steps' : 'Continue upgrade or recovery'}
                  </Button>
                )}
                <Button appearance="default" onClick={dismiss}>
                  {prompt.kind === 'in-progress' ? 'Dismiss until next reload' : 'Postpone'}
                </Button>
              </div>
            </div>
          </ModalBody>
        </ModalDialog>
      ) : null}
    </ModalTransition>
  );
};
