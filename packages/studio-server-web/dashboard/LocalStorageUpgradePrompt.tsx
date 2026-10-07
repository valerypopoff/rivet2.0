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
  uiPreparationAvailable?: boolean;
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
        // Bound the whole read (including response bodies). A stalled status
        // endpoint must not strand this page's reminder indefinitely.
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
        const setupResponse = await fetch(`${RIVET_API_BASE_URL}/app-settings/local-upgrade/setup`, {
          cache: 'no-store',
          signal,
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
          signal,
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
          label="Local storage upgrade"
          onClose={dismiss}
        >
          <ModalBody>
            <div className="local-storage-upgrade-prompt">
              {prompt.kind === 'setup' && prompt.setup.uiPreparationAvailable && !prompt.setup.sqliteSelected ? (
                <>
                  <h2>Prepare the local storage upgrade</h2>
                  <p>
                    The guided upgrade can prepare persistent control storage and restart the backend for you. Local
                    settings are unencrypted. No encryption key, console commands or .env entries are needed.
                  </p>
                  <p>
                    Then pause writes, create and download the verified backup, copy and verify, and activate SQLite.
                    Restarts and paused validation are automatic. You make the final decision to resume writes.
                  </p>
                  <p>
                    You can postpone, or return to legacy before resuming SQLite writes. Keep the downloaded backup
                    securely outside this VM; it contains private settings and credentials.
                  </p>
                </>
              ) : prompt.kind === 'setup' && prompt.setup.sqliteSelected ? (
                <>
                  <h2>Restore paused SQLite upgrade controls</h2>
                  <p>
                    SQLite is already selected, but writes are still paused. Restore the original persistent control
                    volume and use the supported combined backend launcher. Do not select a new empty storage root.
                  </p>
                  <p>
                    Do not reset the control volume or run provisioning again. Older encrypted installations also need
                    their original key until plaintext conversion completes. Once the backend is available, continue
                    paused validation or return to legacy. If it cannot start, use the documented offline recovery
                    procedure; never clear the maintenance marker by hand.
                  </p>
                </>
              ) : prompt.kind === 'setup' ? (
                <>
                  <h2>Prepare the local storage upgrade</h2>
                  <p>
                    This deployment cannot prepare persistent control storage from the browser. Update the Compose
                    definition and combined backend launcher to enable guided preparation. The supported launcher
                    selects storage automatically; new migrations do not require an encryption key or .env entries.
                  </p>
                  <ul>
                    <li>
                      Preserve the persistent <code>rivet_local_metadata</code> volume and all four original source
                      mounts. Never reset or re-provision an existing upgrade.
                    </li>
                    <li>
                      Custom launchers require administrator setup using the documented manual procedure. Older
                      encrypted installations must retain their original key until conversion completes; never generate
                      a replacement key or enter it in this browser.
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
                {(prompt.kind !== 'setup' || (prompt.setup.uiPreparationAvailable && !prompt.setup.sqliteSelected)) && (
                  <Button
                    appearance="primary"
                    onClick={() => {
                      dismiss();
                      onStart();
                    }}
                  >
                    {prompt.kind === 'offer' || prompt.kind === 'setup'
                      ? 'Review upgrade steps'
                      : 'Continue upgrade or recovery'}
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
