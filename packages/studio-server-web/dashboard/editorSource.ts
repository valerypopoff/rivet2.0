/** Keep a dashboard and its iframe on one immutable frontend build. Runtime
 * configuration and API requests remain absolute, current-origin URLs. */
export function editorSource(document: Document, developmentGeneration: string | null): string {
  if (developmentGeneration) return `/?editor&devBuild=${encodeURIComponent(developmentGeneration)}`;
  const build = document.querySelector<HTMLMetaElement>('meta[name="rivet-web-build"]')?.content;
  return build && /^[a-f0-9]{64}$/.test(build) ? `/?editor&webBuild=${build}` : '/?editor';
}
