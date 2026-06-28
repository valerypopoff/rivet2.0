---
title: 'Rivet Web Apps'
---

Rivet web apps are small project-contained user interfaces that can call graphs in the same project. They are useful when you want a simple form, button, and result view for a workflow without building and hosting a separate frontend.

Web apps are saved in the `.rivet-project` file, but they are not workflow graphs. They cannot be selected as the Main Graph, they do not have nodes or connections, and they are not run by the normal graph executor.

## Creating a Web App

Open the left graph panel and use **New web app** in the **Web Apps** section. Right-click an existing web app to duplicate it or delete it. Delete asks for confirmation before removing the web app from the project.

A web app contains declarative components:

- text
- markdown text
- input
- textarea
- button
- output

The web app editor shows the component settings on the left and a live preview on the right.

Use the **Components** palette to add blocks. Hover a component type to reveal the plus icon, then click to add it. Drag an added block by its header strip to change the order shown in the web app.

When a block is focused in the settings panel, Rivet highlights the matching component in the live preview. Focusing or clicking a component in the preview highlights the matching settings block.

Markdown components render Markdown in the editor preview and hosted web app instead of showing raw Markdown source. Output components can also render stored state as Markdown by setting **Render as** to **Markdown**. Rivet uses the same Markdown engine in the editor preview and in server-hosted web apps, so headings, lists, emphasis, and code blocks should render consistently in both places. Raw HTML inside Markdown is escaped in web apps.

## Binding a Button to a Graph

Button components can run ordinary graphs from the same project.

For each button, choose:

- **Target graph**: the graph to run
- one or more **Graph input ID** / **Data key to send** rows
- at least one **Graph output ID** / **Data key to save to** row
- **Label**: the button text shown in the web app

For example, a textarea can write to data key `input`, a button can send that value to graph input `input`, and an output component can render the resulting `result` data key.

If a **Graph output ID** is empty, Rivet stores the whole graph output object at the chosen data key. If it is set, Rivet reads that graph output and stores the inner Rivet value. For example, if the graph has a Graph Output node with ID `graphOutput` and the run returns `{ graphOutput: { type: 'string', value: 'Hello' } }`, setting **Graph output ID** to `graphOutput` stores `Hello` in the web app data. If the target graph does not return that ID, the action shows an error instead of silently storing an empty value.

## Previewing Locally

Click **Run web app** to open a separate preview window named after the web app. The preview uses the same declarative renderer as hosted web apps. When you click a button in the preview, Rivet runs the target graph through the editor's normal graph-run path with the editor's current providers, context values, settings, attached data, plugins, and project references.

Because preview actions are real editor graph runs, you can open the target graph after clicking a web app button and inspect the generated node outputs, run history, durations, errors, and graph outputs just like you can after clicking **Run project**.

Preview state is temporary. Editing the web app changes the project and can be saved like other project changes. The preview window stays open if you switch back to a workflow graph in the editor; close the preview window when you are done with it.

## Serving From a Wrapper

The `@valerypopoff/rivet2-node` package exports `createRivetWebAppHandler(...)`. A wrapper can load a project, choose a UI graph, and adapt the handler to its own HTTP server. Wrapper servers usually mount web apps under their own route family, for example `/apps/my-tool`, while Rivet serves the HTML renderer and the button action endpoint under that base path.

Button actions are ordinary same-project graph runs. A wrapper can provide request-scoped processor options so web app actions use the same code runner, runtime libraries, dataset provider, project reference loader, context, recordings, and telemetry policy as normal workflow endpoints.

Wrappers can also use lower-level helpers:

- `renderRivetWebAppHtml(...)` to serve the HTML from a wrapper-owned route
- `runRivetWebAppAction(...)` to run a button action from an existing route handler

Action requests are JSON-only and the web app state must be an object. If a wrapper uses the lower-level action helper, Rivet throws `RivetWebAppActionHttpError` for request-shaped failures such as malformed state or stale revision keys so the wrapper can return the matching HTTP status.

If a wrapper publishes immutable project revisions, it can pass a `revisionKey`. Rivet embeds that opaque key into the served page and rejects action requests that send a different key, helping wrappers avoid a stale page running against a newer published app revision.

Wrappers still own:

- authentication
- URLs and domains
- deployment
- tenancy
- request context
- project loading and permissions
- revision routing and cache invalidation
- response headers, debug headers, recordings, and public error envelopes

Rivet only provides the declarative renderer and the action endpoint that runs same-project graphs.

## V1 Limitations

V1 is intentionally small and safe:

- web apps can call only graphs in the same project
- there is no custom JavaScript
- there is no separate raw HTML component
- markdown components and markdown output mode follow Rivet's standard Markdown renderer, with raw HTML escaped
- there is no custom asset pipeline
- there are no reusable UI components or page navigation yet

Use ordinary graphs for workflow logic and web apps for a minimal UI over those graphs.
