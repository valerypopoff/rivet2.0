# Recordings

Using the `ExecutionRecorder` class in your code, you can generate `.rivet-recording` files that contain
recorded executions of a rivet graph and all its subgraphs.

This documentation is about using `rivet-recording` files to replay your recordings. For information on how to
generate recordings, see the [recording API documentation](../api-reference/recording.md).

## Loading a Recording

### Finding recordings in Rivet Server

Open **Run recordings** and leave the workflow selector on **Any** to browse all workflows, or choose an individual workflow. **Any** is always the first option and the default for a newly opened recordings session. The workflow details card appears only when an individual workflow is selected. **Bad only**, pagination and **Filter by input** work in either mode. Input filters search captured request input with a JSON path such as `$.requestId`. Matching runs appear progressively, newest first. **Stop search** keeps the results already found; changing the filter starts a new search.

Click the refresh icon beside **Run recordings** to reload the workflow list and
recordings as if you closed and reopened the modal. It resets to **Any**, **All**,
page 1 and 20 runs per page, clearing the current input search and expanded
sub-runs. Your saved input-path history remains available. Refresh is temporarily
disabled while a recording is opening or being deleted.

### Recording editor runs

Enable **Record local graph executions** in Rivet settings to retain live hosted editor runs in **Run recordings**. Both Browser execution and Studio Server's internal Node executor can capture the parent run and called-project Subgraph runs, including successful runs with no LLM nodes. Server recording policy and retention still apply. Desktop or external Remote Debugger execution does not upload through this hosted-editor feature, and replaying an old recording does not create a new one.

A parent may succeed even if a child fails when the Subgraph's error output handles that failure. Each recording retains its own outcome. An interrupted connection or failed upload may leave a run unavailable; do not assume a completed graph guarantees a retained recording.

### Estimated cost statistics

Open **Run statistics**, choose an endpoint or web-app action and a time period,
then see separate **Duration** and **Cost** panels. **Workflow endpoint** selects
a workflow's retained endpoint history, not a separate URL: renaming its endpoint
does not split that workflow's history. Web-app action and editor runs are not
mixed into its endpoint statistics.

The **Include failed runs** and **Include runs with warnings** checkboxes beside
Period/Version control both panels. The summary shows **N runs, Date 1 to Date 2**
for the included runs, with no separate cost-coverage count line. With both
checkboxes off, no outcome cards are shown. Enabling failed runs shows
Succeeded/Errors cards; enabling warnings shows Succeeded/Warnings; enabling
both shows all three. Percentages use the included runs as their total.

Each panel has its own **By day / By week** control, initially **By day**, so
grouping one chart does not change the other. **Cost over time** always shows
both **Known subtotal** and **Average per complete run**, distinguished by its legend.
Both charts and the totals use the same recording snapshot, even with different
grouping selections.
Day/week boundaries use UTC; displayed dates use your browser's local time.

For supported server AI calls, a root run includes work performed in referenced projects, including bundle members and background branches. Sub-runs are not added twice. Retries can incur additional cost; cached responses and recording playback do not create new provider charges in these estimates.

Coverage distinguishes **complete**, **partial** and **unknown** estimates among the included runs. Partial runs contribute only their known subtotal; the average includes complete estimates only. Unknown is not zero. Older recordings, unknown model prices and unavailable attempt evidence can leave coverage incomplete. Enable failed or warning runs above the panels to include their duration and cost evidence; they are excluded from both by default.

Cancelling a web-app action does not erase costs from calls that already finished. Its recording normally waits for execution cleanup; if that cannot finish promptly, Rivet preserves the known subtotal as partial rather than presenting it as a complete total. If no priced call has finished, the estimate remains unknown—not $0. A provider-reported zero remains valid evidence.

These are USD estimates for retained endpoint/web-app recordings—not provider billing totals. Editor runs and arbitrary external calls from Code or third-party plugins are outside this chart's scope. Disabled, lost or expired recordings are not counted. Runs are grouped by their start time and appear after final recording persistence, which can be later than an early HTTP response when background work continues.

### Roots and sub-runs

Selecting the caller workflow also includes related called-project Subgraph recordings, including nested calls. Root runs start folded; expand a root to inspect its indented **Sub-run** cards. Each child has its own replay and delete actions, project and called-graph details, and **Related run key**. Root cards hide that key. Folding or unfolding does not start playback.

**Per page** limits top-level runs, not their sub-runs. For example, a page set to 20 can contain 20 parent runs even when one has 151 children. Expand a run to load all its retained sub-runs; they do not use page slots and are shown regardless of their own success/failure status. **Bad only** selects matching top-level entries or related-child groups. If the primary is filtered out, outside the selected project, missing or ambiguous, a **Related sub-runs** context group keeps those children accessible without inventing a parent. Each context group uses one top-level slot; legacy recordings without a usable related-run key remain separate entries. All linked descendants appear at one indentation level, not a reconstruction of immediate nested call order.

**Filter by input** searches only root recordings, not child inputs. Expand a matching root to load all retained linked sub-runs regardless of their own input values or success/failure status. Child loading does not increase the root match count or search progress. A child-load error offers retry separately from a root-search error. To investigate a child-only input value, find its family through the caller's input or use ordinary browsing under **Any** or the called project.

**Any** lists each retained recording once. Older recordings without a related run key, or children whose root recording has been deleted, can only be found under **Any** or their called project.

Counts in the workflow dropdown say **in this project** because they count that
project's own recordings; the selected table can contain additional related child
recordings. Deleting a parent does not delete its child recordings. Without that
parent's run key anchor, find those children through **Any** or their called project.

Run duration text is rounded to two decimal places; recorded timings keep their original precision. Opening a replay temporarily hides the modal but keeps its workflow, filter, page and expanded families for when you return. Explicitly closing it resets the session to **Any**.

### Reusing input filter paths

After a valid **Apply**, Rivet remembers the trimmed **Input JSON path** in this browser. Focus the field to choose a previous path; repeated values are not duplicated and the most recently applied path comes first. Use a saved path's delete control to remove a typo or unwanted entry. Selecting a saved path changes the draft only: click **Apply** to search. Deleting a saved path does not clear the active filter. This history is a browser preference, not shared server data; if browser storage is unavailable, it works only in memory until reload.

### Search progress and deletion

Search shows an initial match promptly, then collects larger batches automatically. The ordinary runs-per-page setting does not limit the total search results. Repeated searches can reuse recently extracted inputs, but large histories may exceed the server's memory cache and still require reading recording files again.

**Search complete** means the scan finished. **Search stopped** means the results may be incomplete, including when an unreadable or malformed recording caused an error. Check the displayed error before treating an empty result as proof that no matching run exists.

Deleting a recording temporarily disables row actions in that view until deletion and refresh finish. You can switch workflows or close the modal while it is pending; this does not undo the deletion, and its late response will not replace the new view's results.

Deleting also stops an active input search and keeps its collected matches. If deletion fails, the error is shown and the search stays stopped; use **Apply** to run the search again.

### Loading a recording file

Once you have a `rivet-recording` file, you can load it into Rivet using the `Load Recording` option in the action bar dropdown,
or by pressing `Cmd/Ctrl + Shift + O` and selecting the file.

When loaded, the border reflects the recording's outcome: green for success, red
for failure, and yellow for suspicious or unknown results. Loading a file over
an ordinary project also shows **Unload Recording** in the action bar.

Recordings opened from Studio Server's **Run recordings** modal have their own
standalone tabs. These tabs do not show **Unload Recording**, because there is
no ordinary project behind them. Close the recording tab when finished.

If `Show node run durations` is enabled in Settings, replayed node outputs show `Duration: ...ms` when the recording contains timing metadata. Older recordings may also show approximate durations derived from their recorded start/finish event timestamps. If the same recorded node has multiple finished runs, including many parallel or sequential runs, Rivet shows the total duration plus one line per run. Turn the setting off to hide these duration lines.

## Saving a Recording

When a recording is loaded, open the action bar's **...** menu and choose **Export recording** to download it. Rivet serializes that original recording's execution evidence, even after you play it. Playback is a visual replay of past execution evidence, not a new execution recording, so exporting it never replaces the original timeline with the much faster playback delivery timeline.

If no recording is loaded, **Save Recording** remains directly in the action bar and downloads the most recent recording captured from a normal local run.

## Playing a Recording

When a recording is loaded, the Play button turns into a "Play Recording" button. Pressing this button will play the recording.

A recording will play back chat-output events from [LLM Chat](../node-reference/llm-chat.mdx) and legacy [Chat](../node-reference/chat.mdx) nodes at a fixed rate. This rate is configurable in the
"General" area of the Rivet settings panel.

Intermediate nodes between chat-output events will be replayed instantly.

Run Activity and the Response inspector show the original recorded timing, not the time required to replay it. If an older or interrupted recording is missing a node's finish/error event—or the overall run has no recorded start—Rivet shows that duration as unavailable instead of guessing from a model call or playback speed.

During playback, you can press the `Pause` button in the action bar to pause the recording where it currently is. Pressing `Resume` will resume the recording from this point.

If a recording is aborted, you can click `Play Recording` again to restart it from the beginning.

For a recording loaded over an ordinary project, click **Unload Recording** in
the action bar to return to normal execution. For a standalone tab opened from
**Run recordings**, close the tab instead.
