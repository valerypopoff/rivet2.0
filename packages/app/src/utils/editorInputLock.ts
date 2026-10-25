/** Host locks and modal admission are independent of where keyboard focus happens to be. */
export function isEditorInputLocked(owner: Document): boolean {
  return !!owner.querySelector('html[inert], body[inert], .app[inert], [inert] .app, [aria-modal="true"]');
}
