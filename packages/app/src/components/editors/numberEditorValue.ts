export type NumberEditorChange = { valid: true; value: number | undefined } | { valid: false };

/** Keep invalid browser drafts out of authoritative node data. */
export function resolveNumberEditorChange(
  text: string,
  valueAsNumber: number,
  allowEmpty: boolean,
  storageMultiplier: number = 1,
  badInput: boolean = false,
): NumberEditorChange {
  // Number inputs expose incomplete text (such as "1e") as an empty value.
  // Only an actually empty field represents the operator's request to clear it.
  if (badInput) return { valid: false };
  if (text === '' && allowEmpty) return { valid: true, value: undefined };
  if (!Number.isFinite(valueAsNumber)) return { valid: false };
  const value = storageMultiplier === 1 ? valueAsNumber : Math.round(valueAsNumber * storageMultiplier);
  return Number.isFinite(value) ? { valid: true, value } : { valid: false };
}
