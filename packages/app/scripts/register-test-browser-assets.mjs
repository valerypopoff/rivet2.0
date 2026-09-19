import { registerHooks } from 'node:module';

const browserAssetExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp', '.woff', '.woff2']);
const stylesheetExtensions = new Set(['.css', '.less', '.sass', '.scss']);
const testIconModuleUrl = new URL('./test-browser-icon.mjs', import.meta.url).href;
const testPortalModuleUrl = new URL('./test-browser-portal.mjs', import.meta.url).href;
const testCollapsibleModuleUrl = new URL('./test-browser-collapsible.mjs', import.meta.url).href;
const testSelectModuleUrl = new URL('./test-browser-select.mjs', import.meta.url).href;

function getExtension(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  const dotIndex = pathname.lastIndexOf('.');
  return dotIndex >= 0 ? pathname.slice(dotIndex) : '';
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Yarn PnP resolves package paths before Node's load hook sees them, and
    // it treats Vite's resource query as part of the physical package path.
    // Resolve the package resource first, then retain the query for `load`.
    if (specifier.endsWith('?react')) {
      const resolved = nextResolve(specifier.slice(0, -'?react'.length), context);
      return { ...resolved, url: `${resolved.url}?react` };
    }

    // Atlaskit's published CommonJS entry points expose a nested `default`
    // object to Node ESM while Vite selects their browser build. Component
    // tests need the same component-shaped contract, not the browser glyph
    // implementation, so isolate that adaptation in this test-only loader.
    if (specifier.startsWith('@atlaskit/icon/glyph/')) {
      return { shortCircuit: true, url: testIconModuleUrl };
    }
    if (specifier === '@atlaskit/portal') {
      return { shortCircuit: true, url: testPortalModuleUrl };
    }
    if (specifier === 'react-collapsible') {
      return { shortCircuit: true, url: testCollapsibleModuleUrl };
    }
    if (specifier === '@atlaskit/select') {
      return { shortCircuit: true, url: testSelectModuleUrl };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) {
      return nextLoad(url, context);
    }

    const parsedUrl = new URL(url);
    const extension = getExtension(url);

    if (extension === '.svg' && parsedUrl.searchParams.has('react')) {
      return {
        format: 'module',
        source: 'export default function BrowserAssetComponent() { return null; }',
        shortCircuit: true,
      };
    }

    if (stylesheetExtensions.has(extension)) {
      return {
        format: 'module',
        source: 'export default {};',
        shortCircuit: true,
      };
    }

    if (browserAssetExtensions.has(extension)) {
      parsedUrl.search = '';
      parsedUrl.hash = '';
      return {
        format: 'module',
        source: `export default ${JSON.stringify(parsedUrl.href)};`,
        shortCircuit: true,
      };
    }

    return nextLoad(url, context);
  },
});
