import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AppSettingsResource } from '../appSettingsApi';

export type SettingsFormResource<TSettings, TForm, TDraft, TStatus extends string> = {
  baseline: TForm;
  clearFeedback(): void;
  error: string | null;
  form: TForm;
  loaded: boolean;
  loading: boolean;
  resetForm(nextForm?: TForm): void;
  save(draft: TDraft, status?: TStatus): Promise<TSettings | undefined>;
  saved: boolean;
  saving: boolean;
  setForm: Dispatch<SetStateAction<TForm>>;
  status: TStatus | null;
};

type SettingsFormResourceOptions<TSettings, TForm, TDraft, TStatus extends string> = {
  afterSave?: (settings: TSettings, status: TStatus | null) => Promise<void> | void;
  defaultForm: TForm;
  enabled: boolean;
  mergeSavedForm?: (saved: TForm, current: TForm, status: TStatus | null) => TForm;
  resource: AppSettingsResource<TSettings, TDraft>;
  toForm: (settings: TSettings) => TForm;
};

export function useSettingsFormResource<TSettings, TForm, TDraft, TStatus extends string = never>({
  afterSave,
  defaultForm,
  enabled,
  mergeSavedForm,
  resource,
  toForm,
}: SettingsFormResourceOptions<TSettings, TForm, TDraft, TStatus>): SettingsFormResource<TSettings, TForm, TDraft, TStatus> {
  const [baseline, setBaseline] = useState(defaultForm);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(defaultForm);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<TStatus | null>(null);
  const toFormRef = useRef(toForm);
  const mergeSavedFormRef = useRef(mergeSavedForm);
  const afterSaveRef = useRef(afterSave);
  toFormRef.current = toForm;
  mergeSavedFormRef.current = mergeSavedForm;
  afterSaveRef.current = afterSave;

  useEffect(() => {
    if (!enabled || loaded) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);

    resource.read()
      .then((result) => {
        if (cancelled) {
          return;
        }

        const nextForm = toFormRef.current(result.settings);
        setBaseline(nextForm);
        setForm(nextForm);
        setRevision(result.revision);
        setLoaded(true);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, loaded, resource]);

  const clearFeedback = () => {
    setError(null);
    setSaved(false);
    setStatus(null);
  };

  const resetForm = (nextForm = baseline) => {
    setForm(nextForm);
    clearFeedback();
  };

  const save = async (draft: TDraft, nextStatus?: TStatus) => {
    const statusValue = nextStatus ?? null;
    setSaving(true);
    setError(null);
    setSaved(false);
    setStatus(statusValue);

    try {
      const result = await resource.update(draft, revision);
      const savedForm = toFormRef.current(result.settings);
      setBaseline(savedForm);
      setForm((current) => mergeSavedFormRef.current?.(savedForm, current, statusValue) ?? savedForm);
      setRevision(result.revision);
      await afterSaveRef.current?.(result.settings, statusValue);
      setSaved(true);
      return result.settings;
    } catch (saveError) {
      if ((saveError as { status?: number }).status === 409) {
        try {
          const latest = await resource.read();
          setBaseline(toFormRef.current(latest.settings));
          setRevision(latest.revision);
          setError('Settings changed in another session. The latest saved baseline was refreshed; review and save again.');
          return undefined;
        } catch {
          // Keep the original conflict message when the follow-up read also fails.
        }
      }
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  return {
    baseline,
    clearFeedback,
    error,
    form,
    loaded,
    loading,
    resetForm,
    save,
    saved,
    saving,
    setForm,
    status,
  };
}
