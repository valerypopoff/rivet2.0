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

This short root command runs the docs package's `dev` script and starts a local
development server. Most changes are reflected live without having to restart
the server. `yarn docs build`, `yarn docs serve`, and `yarn docs typecheck` use
the same forwarding command.

### Build

```bash
yarn workspace docs build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

### Maintenance

When app/runtime behavior changes, update both these public docs and the matching developer docs under `developer-docs/`. The developer docs are the implementation-facing source of truth; this site is the user-facing/API-facing version of the same contract.
