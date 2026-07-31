# Rivet 2 Docs

This package contains the Docusaurus documentation site for Rivet 2.

The docs should describe the current Rivet 2 package and app shape:

- User Guide pages, especially the introduction, are for desktop app users; introduce Rivet as a visual low-code tool for AI and non-AI workflows, quick experiments, production workflows, and the optional self-hosted web-app form through Rivet Studio Server, while runtime package, CLI, source-checkout, and wrapper embedding details belong in the API Reference
- public runtime packages: `@valerypopoff/rivet2-core`, `@valerypopoff/rivet2-node`, `@valerypopoff/trivet`, and `@valerypopoff/rivet2-cli`
- desktop/editor package: `@valerypopoff/rivet-app`
- Node executor package: `@valerypopoff/rivet-app-executor`
- app-level plugin installation with project YAML plugin declarations derived from actual plugin-node usage
- LLM Chat as the recommended chat node for new graphs
- Browser, Node, and remote executor behavior
- `/download`, including stable Windows/macOS release metadata from the main-branch Pages workflow and developer Windows/macOS release metadata from the develop-branch Pages workflow
- wrapper/embedding seams documented in the repo's developer docs
- article typography should keep body text close to its preceding heading while preserving larger default gaps between adjacent headings

The GitHub Pages deployment uses `baseUrl: /rivet2.0/`. The Docusaurus pages
plugin owns the promotional homepage at `/`, while the docs plugin continues to
serve the User Guide at `/user-guide` and preserves the existing Tutorial, API,
Node Reference, CLI, download, and deep documentation routes.

The landing-page copy is intentionally centralized in
`src/content/homepageContent.ts`. Update that file for ordinary wording, card, or
CTA changes. `src/pages/index.tsx` owns the page structure and
`src/pages/index.module.css` owns its isolated responsive presentation.
The hero keeps its introductory copy above the workflow showcase at every
viewport width; its concise feature explanations sit to the left of the example
workflow on wide layouts and move above it as space narrows.
Keep the hero calls to action in one non-shifting row, with the source link
following the two primary actions. On screens wider than 620px, the workflow
showcase embeds the real Rivet editor from the separately built
`/rivet-demo/` entry. Its checked-in project lives at
`../app/src/promo/promo.rivet-project`, runs deterministically without plugins,
providers, API keys, or external calls, and uses fresh in-memory app storage on
every iframe load. Its Roboto and Roboto Mono files are bundled with the promo
entry rather than fetched from a third-party font host. The frame stays
non-interactive until clicked so it cannot
capture normal page scrolling; Escape releases it, Reset reloads it, and the
full-screen link opens the same static entry directly. Startup uses a
parent-request/child-response status handshake in addition to the child's
initial ready event, so a fast iframe cannot leave the landing page permanently
stuck on its loading overlay by posting readiness before the parent listener is
attached. The trusted frame allows
same-origin ES-module loading, while the bundled project, editor-state provider,
and static-data provider use fresh in-memory stores instead of loading or saving
the documentation site's persisted Rivet state. The promo host also blocks
browser File commands. Any future feature added to this surface that writes
directly to browser storage must be reviewed separately. Narrow screens keep the
responsive completed-run illustration and link to the full demo instead of
loading the full editor inline. The
foundation cards use one descriptive heading per item; avoid adding redundant
all-caps labels or decorative proof bars back to the hero.
At the narrowest responsive breakpoint, the hero title scales down and the
workflow preview uses compact staggered nodes so its forward data connections
remain legible rather than crossing through a full-width mobile stack.
The docs shell and landing page intentionally mirror Rivet's canonical themes:
locally bundled Roboto/Roboto Mono typography, the Molten palette in dark mode,
and the Bright palette in light mode. Keep this small semantic mirror in `src/css/custom.css`
and the landing module rather than importing the editor's global app styles.

### Installation

```bash
yarn install --immutable
```

### Local Development

```bash
yarn docs dev
```

This short root command first builds the embedded Rivet promo with development
asset paths, then starts Docusaurus on port 3000 and a strict-port static Vite
preview on port 5174. Serving the bundled promo here is intentional: loading the
full Rivet source module graph independently in every open documentation tab
can overwhelm a local browser and leave the parent page waiting indefinitely.
Landing-page text and CSS still update through Docusaurus hot reload. Changes to
the promo host or bundled project require restarting `yarn docs dev`, which
rebuilds that entry before serving it. Stop the parent command to stop both
servers. `yarn docs build`, `yarn docs serve`, and `yarn docs typecheck` use the
same forwarding command.

### Build

```bash
yarn workspace docs build
```

This command validates the bundled promo project, builds Docusaurus, builds the
Rivet demo into `build/rivet-demo`, and checks the demo's initial and total
asset budgets. The promo build derives its absolute asset base from
Docusaurus's `baseUrl`, so the directory index works both on GitHub Pages and
when Docusaurus's static preview canonicalizes it to a no-trailing-slash URL.
The result is one static directory suitable for GitHub Pages or any other
static-content host. Generated promo assets remain under the ignored `build`
directory and are never checked in.

The docs TypeScript configuration excludes generated `build/` output so
typechecking remains source-only and produces the same result before or after a
production build.

### Maintenance

When app/runtime behavior changes, update both these public docs and the matching developer docs under `developer-docs/`. The developer docs are the implementation-facing source of truth; this site is the user-facing/API-facing version of the same contract.
