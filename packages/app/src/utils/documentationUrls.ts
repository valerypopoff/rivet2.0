/** Published documentation routes used by the Rivet editor.
 *
 * Keep user-facing guides on GitHub Pages rather than source-tree URLs so the
 * desktop app, hosted editor, and browser builds all open the same rendered
 * documentation.
 */
export const USER_GUIDE_URL = 'https://valerypopoff.github.io/rivet2.0/user-guide';

export const EVALUATIONS_DOCUMENTATION_URL = `${USER_GUIDE_URL}/evaluations`;

export function getBuiltInPluginDocumentationUrl(pluginSlug: string): string {
  return `${USER_GUIDE_URL}/plugins/built-in/${pluginSlug}`;
}
