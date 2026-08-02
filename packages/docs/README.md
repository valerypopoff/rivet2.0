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
Node Reference, CLI, download, and deep documentation routes. The production
bundle check verifies that the generated landing-page iframes target
`/rivet2.0/rivet-demo/`, contain no development host paths, and ship with the
`.nojekyll` marker required by the Pages artifact.

The landing-page copy is intentionally centralized in
`src/content/homepageContent.ts`. Update that file for ordinary wording, card, or
CTA changes. `src/pages/index.tsx` owns the page structure and
`src/pages/index.module.css` owns its isolated responsive presentation.
The hero keeps its introductory copy above three horizontal demo tabs at every
viewport width. Those tabs select Agent, Workflow, or Web App in that order,
with Agent selected initially, and one eagerly mounted Rivet window sits beneath
them. Foundations and Use Cases each own another eagerly mounted window:
Foundations opens the fixed batch-runs project and Use Cases opens the fixed
structured-output project. These are three independent, section-owned iframe
instances rather than one shared demo lab.
Keep the hero calls to action in one non-shifting row, with the source link
following the two primary actions. At every supported viewport width, each
section window embeds the real Rivet editor from the separately built
`/rivet-demo/` entry. The checked-in projects live at
`../app/src/promo/projects/promo-agent.rivet-project`,
`../app/src/promo/projects/promo-workflow.rivet-project`, and
`../app/src/promo/projects/promo-web-app.rivet-project`, with the contextual examples in
`../app/src/promo/projects/promo-batch-runs.rivet-project` and
`../app/src/promo/projects/promo-structured-output.rivet-project`. All landing-page projects stay together in this
dedicated `promo/projects` directory. The canonical
manifest in `../app/src/promo/promoProjectManifest.ts` owns their query ids,
project ids, initial graphs, paths, and loading hints. The whitelisted `project`
query selects one of those five demos; an unknown value produces an explicit
startup error instead of silently opening a different project. Each project uses only built-in nodes, contains
one blank `API Key — paste yours here` Text node wired to every LLM Chat API-key
input, keeps its provider/model settings inline instead of adding LLM Profile
nodes, and uses fresh in-memory app storage on every iframe load. No credential
is bundled or retained when the iframe is reset or another demo is selected.
The agent has one necessary subgraph: the handler for its typed tool. The model
receives that result and produces the final answer. The parallel workflow and
web-app backing workflow each stay in one graph; the web-app project adds only
its Chat UI resource. The batch-runs demo uses a typed `string[]` Graph Input
with three default requests, keeping the example data visible without an extra
code node. Unused diagnostic LLM outputs stay hidden so first-time visitors see
only the ports that explain each example. The LLM-backed graphs
intentionally require the visitor's own OpenAI API key; CI validates their
minimal topology without calling a provider and executes only the agent's
deterministic tool subgraph. Roboto and Roboto Mono files are bundled
with the promo entry rather than fetched from a third-party font host. Each frame
stays non-interactive until clicked so it cannot capture normal page scrolling;
Escape releases that frame, Reset reloads it, and the full-screen action enlarges
the same iframe over a dismissible dark backdrop instead of creating another
editor instance or navigating away. Startup uses a
parent-request/child-response status handshake in addition to the child's
initial ready event, so a fast iframe cannot leave the landing page permanently
stuck on its loading overlay by posting readiness before the parent listener is
attached. Until that handshake succeeds, the parent covers the iframe with an
opaque black Rivet-logo-and-spinner loading surface, so an incomplete or unrelated document
cannot leak into the page. A bounded startup timer turns a missing or invalid
promo host into a retryable error instead of leaving `Loading Rivet 2 editor` forever.
The trusted frame allows
same-origin ES-module loading, while the bundled project, editor-state provider,
and static-data provider use fresh in-memory stores instead of loading or saving
the documentation site's persisted Rivet state. The promo host also blocks
browser File commands and hides the Trivet Tests and Data Studio workspace tabs.
Any future feature added to this surface that writes
directly to browser storage must be reviewed separately. Narrow screens keep all
three section-owned editor windows embedded; responsive layout stacks their
controls and content without replacing the demos with links. The
foundation cards use one descriptive heading per item; avoid adding redundant
all-caps labels or decorative proof bars back to the hero. Descriptive landing
copy uses `--body-copy-size` as its minimum size; compact UI labels, eyebrows,
code, and metadata may remain smaller. Use-case cards use inline, decorative
SVG icons so they stay theme-aware and require no separate image assets.
The production-runtime section is followed by an editable Rivet Studio Server
section sourced from `src/content/homepageContent.ts`; it presents the optional
self-hosted server without making it part of the core Rivet runtime.
At the narrowest responsive breakpoint, the hero title scales down while the
three editor windows remain embedded in their owning sections.
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
asset paths into the ignored `packages/docs/.promo-dev/rivet-demo` directory,
then starts one Docusaurus server on `127.0.0.1:3000`. In development,
Docusaurus adds `.promo-dev` as a static directory, so every iframe uses the
same-origin `/rivet2.0/rivet-demo/` path used by production. There is no second
preview server whose lifecycle or assets can drift away from the docs page.
Production remains under `packages/docs/build/rivet-demo`; this separation lets
`yarn docs build` replace the production output without invalidating a running
development server. `dev:site` serves the latest existing development bundle
but does not rebuild it, so `yarn docs dev` remains the canonical command.
The launcher clears the complete ignored `.promo-dev` static root before each
build so files from an older development layout cannot collide with Docusaurus
or shadow its own routes.
Serving a prebuilt promo is intentional: loading the full Rivet source module
graph independently in every open documentation tab can overwhelm a local
browser. Landing-page text and CSS still update through Docusaurus hot reload.
Changes to the promo host or bundled project require restarting `yarn docs dev`,
which rebuilds that entry before serving it. The launcher checks both loopback
address families before doing the expensive build and reports an occupied port
explicitly instead of connecting to a stale server. `yarn docs build`,
`yarn docs serve`, and `yarn docs typecheck` use the same forwarding command.

### Build

```bash
yarn workspace docs build
```

This command validates the bundled promo project, builds Docusaurus, builds the
Rivet demo into `build/rivet-demo`, and checks the demo's initial and total
asset budgets. The promo build derives its absolute asset base from
Docusaurus's `baseUrl`, so the directory index works both on GitHub Pages and
when Docusaurus's static preview canonicalizes it to a no-trailing-slash URL.
The bundle check also resolves every initial CSS/JavaScript URL and every Monaco
worker URL injected into the entry HTML. This prevents either missing entry
assets or workers written under a duplicated public-path directory. The
app-local `check:promo-project` command owns project topology and provider-free
fixture execution; the repository-level `check:promo-catalog` command owns the
cross-package contract between that manifest and the section placements in
`homepageContent.ts`.
The result is one static directory suitable for GitHub Pages or any other
static-content host. Generated promo assets remain under the ignored `build`
directory and are never checked in.

The docs TypeScript configuration excludes generated `build/` output so
typechecking remains source-only and produces the same result before or after a
production build.

### Maintenance

When app/runtime behavior changes, update both these public docs and the matching developer docs under `developer-docs/`. The developer docs are the implementation-facing source of truth; this site is the user-facing/API-facing version of the same contract.
