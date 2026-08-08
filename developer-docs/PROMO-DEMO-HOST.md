# GitHub Pages Promo Demo Host

`packages/app/src/promo/main.tsx` is the standalone Rivet editor embedded by
the GitHub Pages landing page. It owns a browser-only, in-memory demo project;
it is not the normal desktop editor and is not a general host-mode switch.

## Surface policy

`packages/app/src/promo/promoHostUi.ts` defines this host's explicit
`RivetAppHostUiConfig` policy. Its Menu deliberately exposes only:

- New project
- Open project
- Save project
- Rivet settings

The same policy disables recording import/export and playback controls, Copy
Inputs for Trivet, AI Graph Builder, and per-editor Generate using AI controls.
The hidden Graph Builder keyboard shortcut is gated by the same capability, so
it cannot activate an invisible interface.

These are host-level opt-outs. `RivetAppHostCapability` defaults every
capability to enabled, so the desktop app and existing `RivetAppHost` wrappers
retain their full behavior unless they explicitly opt out themselves. Do not
add a global `promo` conditional or reuse this policy for another wrapper just
because it wants a smaller UI.

The demo can still open and save project files through the normal browser I/O
provider. That does not make the demo's editor state persistent: its project
state remains fresh in memory and resets when its iframe is remounted.

## Activation and scrolling

The landing page keeps each iframe pointer-transparent until the visitor
chooses `Click to explore this project`. At that point
`pages/index.tsx` sends the typed `rivet-demo:interaction-state` message to
that iframe, and `src/promo/main.tsx` toggles the promo-only
`promo-interaction-active` document class. `promo.css` applies
`overscroll-behavior: contain` only in that state. This prevents a wheel event
at the edge of Rivet's canvas or panels from scrolling the parent landing page,
while preserving normal wheel behavior inside the editor. Releasing the demo
with Escape, resetting it, or closing the large popup disables the containment.
The activation prompt itself is a concise blue action label; do not add a
second instructional sentence below it.

The landing loading overlay uses the same always-spinning circular affordance
as an active Rivet node. It intentionally does not disable that progress
indicator under `prefers-reduced-motion`, because a stationary indicator makes
the startup state indistinguishable from a stalled iframe.

## Landing demo controls

`pages/index.tsx` treats a one-project showcase as a fixed preview rather than
a choice: it omits the redundant `Selected demo` label. The active demo control
still receives a small downward triangle in `index.module.css`, using the
control's accent border color and the same CSS border-triangle construction as
Rivet's generated-output marker. This visually associates the selected project
with the iframe immediately below without changing layout.

Landing-page buttons, links, and demo controls communicate hover through color
and border changes only. They must not translate or deepen their shadow on
hover, and the page deliberately does not append external-link arrow glyphs to
action labels.

The canonical promo catalog contains four projects. The hero switches among
Agent, Workflow, and Web App; the `Visual when it helps. Code when it matters.`
section owns the fourth, fixed `visual-code` project. That project keeps the
ordinary Number, Boolean, and Compare policy gates visible and reserves its
only Code node for the tiered reimbursement route that would otherwise require
a noisy collection of branches. It intentionally has no LLM node or API-key
input, so the contrast is between visible workflow logic and focused custom
code rather than model output. The Use Cases section deliberately has no iframe.
Keep `homepageContent.ts`, `promoProjectManifest.ts`,
`check-promo-project.mts`, and `check-promo-catalog.mts` synchronized whenever
this placement changes.

The Web App hero demo intentionally uses a conventional form-and-result
interface rather than Chat: two editable fields invoke one LLM workflow and a
Markdown output component renders the launch brief. This keeps the landing
page's web-app example representative of ordinary product UIs as well as
conversational ones.

Hero and closing CTA rows inherit the font size of the descriptive lead directly
above them. Do not reintroduce fixed smaller action-label sizes within those
rows; compact controls inside the embedded editor remain independent.

The hero Download action selects a Windows or macOS mark from the visitor's
browser platform after hydration. The GitHub source action uses an inline GitHub
mark and an underlined text treatment. Landing cards and controls use
`corner-shape: squircle` where supported, while intentional dots, glows, and
other circular status markers remain round.

The Rivet Studio Server landing section is a factual product summary rather than
a simulated server card. Its fact blocks cover the browser editor, server-owned
project library, UI publication of workflows and web apps, Remote Debugger,
recording replay, and run statistics. Keep that copy and its external link
synchronized with the `develop-rivet2` branch of the official
`Rivet-Studio-Server` repository; the repository's default branch describes the
earlier server generation and does not contain every Rivet 2 surface. Remote
debugging is described for latest server runs; published executions are
represented through retained recordings instead of promising that every
published run can attach live.

## Verification

`packages/app/src/promo/promoHostUi.test.ts` asserts the exact allowed Menu
items and disabled capabilities. `HostUiConfigContext.test.ts` asserts that
normal hosts preserve the default-on contract. When adding a capability, add
it to both policy coverage and the relevant rendering or command boundary;
never rely on hiding a visual control alone.
