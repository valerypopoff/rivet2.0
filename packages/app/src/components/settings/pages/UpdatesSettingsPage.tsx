import { type FC, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import Button from '@atlaskit/button';
import { Field, Label } from '@atlaskit/form';
import useAsyncEffect from 'use-async-effect';
import { useCheckForUpdate } from '../../../hooks/useCheckForUpdate.js';
import { wrapAsync } from '../../../utils/errorHandling.js';
import { getAppVersion } from '../../../utils/platform/app.js';
import { checkForUpdatesState, skippedMaxVersionState } from '../../../state/settings.js';
import { fields } from '../settingsPageStyles.js';
import { LabeledToggle } from '../../LabeledToggle.js';
import { getVisibleSkippedUpdateVersion } from './updateSettingsVersionVisibility.js';

export const UpdatesSettingsPage: FC = () => {
  const checkForUpdatesNow = useCheckForUpdate({ notifyNoUpdates: true, force: true });
  const [checkForUpdates, setCheckForUpdates] = useAtom(checkForUpdatesState);
  const skippedMaxVersion = useAtomValue(skippedMaxVersionState);
  const [currentVersion, setCurrentVersion] = useState<string>();
  const visibleSkippedMaxVersion =
    currentVersion === undefined ? undefined : getVisibleSkippedUpdateVersion(currentVersion, skippedMaxVersion);

  useAsyncEffect(async () => {
    setCurrentVersion(await getAppVersion());
  }, []);

  return (
    <div css={fields}>
      <p>
        You are currently on <strong>Rivet {currentVersion ?? ''}</strong>
      </p>
      <Field name="check-for-updates">
        {() => (
          <>
            <LabeledToggle
              id="check-for-updates"
              isChecked={checkForUpdates}
              onChange={setCheckForUpdates}
              label="Check for updates on startup"
              helperMessage="Automatically check for updates on startup"
              className="settings-toggle-field"
            />
          </>
        )}
      </Field>
      <Field name="check-for-updates-now">
        {() => (
          <Button appearance="primary" onClick={wrapAsync(checkForUpdatesNow, 'Check for updates')}>
            Check for updates now
          </Button>
        )}
      </Field>
      {visibleSkippedMaxVersion && (
        <Field name="skipped-update-version">
          {() => (
            <>
              <Label htmlFor="skipped-update-version" testId="skipped-update-version">
                Skipped update version
              </Label>
              <div>
                You have skipped version {visibleSkippedMaxVersion}. You may update by clicking the button above.
              </div>
            </>
          )}
        </Field>
      )}
    </div>
  );
};
