---
title: 'Rivet Web Apps'
---

Rivet web apps are small project-contained user interfaces that can call graphs in the same project. They are useful when you want a simple form, chat, button, and result view for a workflow without building and hosting a separate frontend.

Web apps are saved in the `.rivet-project` file, but they are not workflow graphs. They cannot be selected as the Main Graph, they do not have nodes or connections, and they are not run by the normal graph executor. A graph directly selected by a Button or Chat action is treated as a reachable project entry point in the graph tree, alongside the Main Graph.

Rivet validates every saved web-app component and workflow-bound action when the project opens. Older projects with missing or duplicate component IDs are repaired automatically. If a project file was edited manually and contains an unknown component or is missing a required field, Rivet rejects it with a message that identifies the web app, component index, and invalid field instead of opening a broken renderer.

## Before You Build

Build the workflow first. A web app is the UI around an ordinary graph; it does not replace graph nodes, connections, or execution logic.

Use **Graph Input** nodes for values the app should send into the graph, and **Graph Output** nodes for values the app should receive back. A graph can have no inputs or outputs when that is appropriate, but a Button or Chat can only exchange values that are exposed through those graph-boundary nodes.

For a simple question-and-answer app, a good starting graph has:

1. a Graph Input node with ID `question`
2. the workflow that processes that question
3. a Graph Output node with ID `answer`

Run that graph from the canvas once before wiring it into a web app. This makes it much easier to distinguish workflow problems from UI mapping problems.

## Creating a Web App

Open the left graph panel and use **New web app** in the **Web Apps** section. Right-click an existing web app to duplicate it or delete it. Delete asks for confirmation before removing the web app from the project.

A web app contains declarative components:

- text
- markdown text
- gap
- input
- textarea
- dropdown
- button
- chat
- output

The web app editor shows the component settings on the left and a live preview on the right.

Use the bordered **Components** panel to add blocks. It groups choices into Layout, Input, Action, and Other; hover an add control to reveal its right-facing arrow, then click to append that component. You can also drag a component from the palette into a specific position in the preview. Rivet shows the same highlighted component-sized placeholder that it uses while reordering existing components, then inserts the component when you drop it. In the live preview, drag the large handle to the right of a component to change the order shown in the web app. Hold **Shift** while clicking preview components to select or deselect several at once. You can also hold **Shift** and drag a rectangle across blank preview space to add components to the selection. Press **Delete** to remove the selection, or **Backspace** on macOS; Rivet asks for confirmation before deleting one or more components.

A **Gap** adds empty vertical space between components. Choose **Small**, **Medium**, or **Large** in its settings. It has no visible card surface in the rendered web app, but it remains selectable and draggable in the editor preview.

When a block is focused in the settings panel, Rivet highlights and scrolls the matching component into view in the live preview. Focusing or clicking a component in the preview does the same for the matching settings block. Text input, textarea, and Dropdown components save user-entered values into their **Data key**. For a Dropdown, add or remove items and give each item a visible **Label** plus the string **Value** stored in that data key. Rivet warns on later components if that key is already used by an earlier value source.

## Build Your First Form App

With a graph that has `question` and `answer` boundary IDs, build the corresponding app in five small steps:

1. Add a **Textarea** and set its label, placeholder, and **Data key** to `question`.
2. Add a **Button** and choose the workflow under **Graph to run**.
3. In the Button's input rows, confirm that Graph input ID `question` sends the `question` data key.
4. In the Button's output rows, save Graph output ID `answer` to an app data key such as `answer`.
5. Add an **Output** component, set its **Data key** to `answer`, and choose how it should render the result.

Click the Button in the live preview. The Textarea value is sent to the graph, the graph result is saved into `answer`, and the Output component renders it. This same configuration is used by the detached desktop preview and by a served web app.

## Understanding Data Keys

Data keys are app-local names for values held while a user is using a web app. They are not Graph Input or Graph Output IDs. Inputs, Textareas, Dropdowns, and Button output mappings write data keys. Buttons, Chat additional inputs, and Output components read them.

Map a data key to a Graph Input ID when a graph needs that value. Map a Graph Output ID to a data key when the app should keep the graph's result. The Button and Chat settings show graph-boundary IDs as read-only fields so the IDs come from the selected graph rather than being typed manually.

If a consumer refers to a key that no current component produces, Rivet keeps the saved selection visible but marks the field red so you can repair it without losing the mapping. If more than one producer writes the same key, the later write replaces the earlier value. That can be intentional, but use distinct keys when two values must coexist.

Text and Markdown components render without a surrounding card surface, but remain selectable and draggable in the editor preview. Markdown renders in the editor preview and hosted web app instead of showing raw Markdown source. Output components can also render stored state as Markdown by setting **Render as** to **Markdown**. Rivet uses the same Markdown engine in the editor preview and in server-hosted web apps, so headings, lists, emphasis, and code blocks should render consistently in both places. Raw HTML inside Markdown is escaped in web apps.

Set an Output component's **Render as** option to **Image** when its data key contains an image URL, a complete base64 image data URL, or raw PNG, JPEG, or GIF base64. HTTP(S), relative, and `blob:` image URLs are supported; unsupported values show a clear placeholder instead of being inserted as arbitrary markup. Output components start blank until the selected data key receives a value. Once populated, the Output header keeps its label and collapse control visible. If an Output is collapsed when its data key receives a renderable new value, Rivet unfolds it automatically. Copy and, for JSON, Download overlay the top-right of the expanded content area while the value scrolls inside it. Large output cards can be resized vertically between one line and the rendered value's full height; short outputs stay naturally sized without a resize handle. Collapsing an output returns it to a compact header. The download button saves the displayed JSON as a `.json` file named from the web app and the current date/time. Collapsing an output hides only its value for the current app session; it is not saved into the project.

## Binding a Button to a Graph

Button components can run ordinary graphs from the same project.

For each button, choose:

- **Graph to run**: the graph to run
- **Graph input ID** / **Data key to send** rows, one for each Graph Input in the selected graph
- **Graph output ID** / **Data key to save to** rows, one for each Graph Output in the selected graph
- **Label**: the button text shown in the web app

The **Graph input ID** and **Graph output ID** fields are dimmed, non-editable fields from the selected graph's current Graph Input and Graph Output nodes, so you do not need to type the IDs by hand. For graph inputs and output display components, choose an existing web-app **Data key** from the dropdown. Existing keys come from input, textarea, and Dropdown components, plus values saved by button outputs. For graph outputs, type the **Data key** where the value should be saved; Rivet warns on later rows if that key is already used by an earlier value source. If a Graph Input or Graph Output is renamed, Rivet keeps its data-key mapping. A newly added or unrelated replacement port receives a new default mapping instead of borrowing a mapping from the same row position.

For example, a textarea can write to data key `input`, a button can send that value to graph input `input`, and an output component can render the resulting `result` data key.

When a button sends raw web-app data to a graph, Rivet converts it into normal graph Data Values. Text, numbers, and booleans keep their matching scalar types. Objects become `object` values. Homogeneous arrays become typed arrays such as `string[]`, `number[]`, `boolean[]`, or `object[]`; mixed, empty, null-containing, or nested arrays are sent as `any[]`.

For each Graph Output row, Rivet reads that graph output and stores the inner Rivet value. For example, if the graph has a Graph Output node with ID `graphOutput` and the run returns `{ graphOutput: { type: 'string', value: 'Hello' } }`, the `graphOutput` row stores `Hello` in the chosen web app data key. If the target graph does not return that ID, the action shows an error instead of silently storing an empty value.

## Building a Chat App

Add a **Chat** component when you want a conversational UI over a graph. The Chat block is self-contained, so it can be the only component in an app, but you can place Text, Markdown, Gap, Output, or other components before and after it.

Choose a **Graph to run**, then map three graph boundary IDs:

- **User message input** receives the newly submitted message as a Rivet `string`.
- **Conversation history input** receives the conversation before the newly submitted user message as a native Rivet `chat-message[]` value. The current message is sent only through **User message input**, so a graph can append it exactly once before calling an LLM.
- **Assistant response output** supplies the reply shown in the chat. String outputs are shown directly; other output values are converted into readable text.

When a Chat component is first connected, Rivet first prefers a `chat-message[]` Graph Input for conversation history, then an input named like `history`, `conversation`, or `messages`. It prefers a remaining input named like `user`, `message`, `prompt`, or `question` for the current message, and uses the first Graph Output for the response. Review the three dropdowns before running the app.

Use **Add input** when the Chat graph also needs values from other Input or Textarea components. Each additional row maps one Graph Input ID to one existing web-app data key. You can add rows before those Graph Inputs exist; unfinished rows remain in the editor while you update the graph, but the Chat cannot run until every row is configured. If a mapped Graph Input is later removed, Rivet preserves the row and its data key so you can remap or remove it instead of silently dropping expected context. Rivet sends only explicitly mapped values with the Chat action; unrelated page state stays in the browser.

Press **Enter** to send and **Shift+Enter** for a new line. Only the selected Chat block enters its responding state. Its draft, conversation, and pins are stored locally in the browser for that app's site and URL, so they survive reloads and **Reset app** without being saved into project YAML or sent to the backing graph. Messages stay in chronological order from oldest to newest. Both user and assistant messages render Markdown, including links, lists, and code; raw HTML stays escaped. A short conversation sits at the bottom of the message area beside the composer; as it grows, the conversation scrolls inside the Chat block while the composer stays visible. The Chat block grows to use the page's remaining viewport height while preserving its minimum height; if surrounding components plus the Chat minimum exceed the viewport, the page itself can still scroll normally.

While a response is running, the composer’s green Send control becomes a neutral **Stop** control. It cancels that Chat action without changing the conversation already shown.

Once the conversation has messages, the Chat header includes **Search chat**. Use it, or press `Ctrl+F` on Windows/Linux or `Cmd+F` on macOS while focus is inside the Chat, to search the rendered conversation text. Rivet highlights every visible match, shows the current result as `n/m`, and the previous/next controls keep the active result in view inside the chat history.

Hover an assistant response and use its pin icon to keep it handy during a long conversation. When at least one response is pinned, the Chat header shows the pin count. Open it to review each pinned response together with the user message that preceded it, then select an entry to bring that question to the top of the conversation. Use the **Chat options** (`...`) menu beside the Chat heading and choose **Flush chat history** to remove that Chat block's saved messages and pins while keeping any unsent draft. This affects only local browser state, not project YAML or the backing graph.

## Previewing Locally

In the desktop app, click **Run detached** in the preview area to open a separate preview window named after the web app. Hosted/server Rivet shells can hide this desktop-preview action when web apps are meant to run only after being published as endpoints. The preview uses the same declarative renderer as hosted web apps. When you click a button in the preview, Rivet runs the target graph through the editor's normal graph-run path with the editor's current providers, context values, settings, attached data, plugins, and project references.

Because preview actions are real editor graph runs, you can open the target graph after clicking a web app button and inspect the generated node outputs, run history, durations, errors, and graph outputs just like you can after clicking **Run project**.

Preview state is temporary and is not saved in the project YAML. Use the reset icon in the upper-left corner of the preview to clear fields, outputs, chat messages, errors, and progress and return to the initial app state. The in-editor preview keeps its state and any in-progress Button or Chat action when you switch to another graph or web app builder and come back; the action result appears when you return. Use that action's **Abort** control or Reset to cancel it. Closing the project, deleting the web app, or unloading the desktop window also cancels in-progress preview actions. Opening the project again starts a fresh preview session. Editing the web app changes the project and can be saved like other project changes. The detached preview window stays open if you switch back to a workflow graph in the editor; close the preview window when you are done with it.

## Serving Locally

Use the CLI to run a saved web app outside the desktop editor:

```bash
# When the project contains one web app
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project

# When it contains several web apps
npx @valerypopoff/rivet2-cli serve-app my-project.rivet-project "Question and answer"
```

The CLI serves the app at `http://localhost:3000` by default. Use `--dev` while editing a project file, `--base-path` to mount it below another path, and `--host 127.0.0.1` for local-only access. See the [serve-app command reference](../cli/serve-app.md) for dataset, API-key, auth, and deployment options.

## Serving From a Wrapper

The `@valerypopoff/rivet2-node` package exports `createRivetWebAppHandler(...)`. A wrapper can load a project, choose a UI graph, and adapt the handler to its own HTTP server. Wrapper servers usually mount web apps under their own route family, for example `/apps/my-tool`, while Rivet serves the HTML renderer and graph-action endpoint under that base path.

Button and Chat actions are ordinary same-project graph runs. A wrapper can provide request-scoped processor options so web app actions use the same code runner, runtime libraries, dataset provider, project reference loader, context, recordings, and telemetry policy as normal workflow endpoints.

For graphs that can take minutes, a host can serve actions through Rivet's resumable WebSocket transport instead of keeping one POST request open. The page reconnects after a temporary network/proxy interruption and resumes the same server run rather than starting it again. The active Button or Chat shows its own **Abort** action. Closing or reloading the page detaches from a WebSocket run instead of cancelling it automatically; explicit **Abort** requests cancellation. Automatic resume covers connection loss while the page remains open. A full page reload needs host-provided run discovery to restore an earlier run in the new page session.

To show useful status while a graph works, put a **Report Progress** node on the workflow path. It passes its value through unchanged and can report a message, a percentage, or both. You can also use an **External Call** named `setWebAppStatus` and pass the message as its first argument. Progress appears only on the Button or Chat that started that run. It is temporary UI state, not a Graph Output and not project data.

For compact data that should persist in the user's browser, use External Calls named `setWebAppStorage` and `getWebAppStorage`. For example, `setWebAppStorage("preferences", { density: "compact", sidebarOpen: false })` saves an app setting, while `getWebAppStorage("preferences")` returns that complete value on later actions. Calling `getWebAppStorage()` without a key returns the whole app-local object. This works for settings, short local drafts, client-side caches, or any other compact JSON data your graph needs to reuse. Rivet automatically isolates storage by origin, app URL path, and UI graph ID, so an action receives only its own app's values. Data must be JSON-serializable and is limited by the browser's local-storage quota. It stays on that browser profile, is not synchronized across devices, may be cleared by the user, and should not contain secrets. Hosted graphs receive a snapshot at action start and return changed keys after successful completion; Browser and internal Node executor actions use the same behavior.

Wrappers can also use lower-level helpers:

- `renderRivetWebAppHtml(...)` to serve the HTML from a wrapper-owned route
- `runRivetWebAppAction(...)` to run a Button or Chat action from an existing route handler
- `createRivetWebAppWebSocketGateway(...)` to host reconnectable long-running actions on a wrapper-authenticated WebSocket route

The Node handler serves a self-contained page by default. Production wrappers can enable external assets so Rivet's CSS, Markdown libraries, sanitizer, and client use content-addressed filenames that browsers and CDNs can cache. External mode also avoids inline scripts and styles for stricter Content Security Policy setups. The wrapper still owns the CSP header, asset route or CDN, authentication, and deployment policy.

If a hosted app renders remote, `data:`, or `blob:` image sources, its wrapper-owned Content Security Policy must allow the intended source in `img-src`. Rivet applies `referrer-policy: no-referrer` to rendered Output images, but the wrapper remains responsible for deciding which remote image hosts its deployment permits.

Action requests are JSON-only and the web app state must be an object. If a wrapper uses the lower-level action helper, Rivet throws `RivetWebAppActionHttpError` for request-shaped failures such as malformed state or stale revision keys so the wrapper can return the matching HTTP status and optional machine-readable error code.

If a wrapper publishes immutable project revisions, it can pass a `revisionKey`. Rivet embeds that opaque key into the served page and rejects action requests that send a different key, helping wrappers avoid a stale page running against a newer published app revision. When a served page becomes stale, Rivet shows a blocking message, **This app was updated. Reload to continue.**, with a **Reload** button. The app does not refresh automatically, so typed input remains visible until you choose to reload.

Wrappers still own:

- authentication
- URLs and domains
- deployment
- tenancy
- request context
- project loading and permissions
- revision routing and cache invalidation
- response headers, debug headers, recordings, and public error envelopes
- WebSocket upgrade authentication, origin policy, durable run metadata, and deployment draining

Rivet only provides the declarative renderer and the action endpoint that runs same-project graphs.

## V1 Limitations

V1 is intentionally small and safe:

- web apps can call only graphs in the same project
- there is no custom JavaScript
- there is no separate raw HTML component
- markdown components and markdown output mode follow Rivet's standard Markdown renderer, with raw HTML escaped
- there is no project-authored custom asset pipeline
- there are no reusable UI components or page navigation yet

Use ordinary graphs for workflow logic and web apps for a minimal UI over those graphs.
