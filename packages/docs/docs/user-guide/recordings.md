# Recordings

Using the `ExecutionRecorder` class in your code, you can generate `.rivet-recording` files that contain
recorded executions of a rivet graph and all its subgraphs.

This documentation is about using `rivet-recording` files to replay your recordings. For information on how to
generate recordings, see the [recording API documentation](../api-reference/recording.md).

## Loading a Recording

### Finding recordings in Rivet Server

Open **Run recordings** and leave the workflow selector on **Any** to browse all workflows, or choose an individual workflow. **Any** is always the first option and the default for a newly opened recordings session. The workflow details card appears only when an individual workflow is selected. **Bad only**, pagination and **Filter by input** work in either mode. Input filters search captured request input with a JSON path such as `$.requestId`. Matching runs appear progressively, newest first. **Stop search** keeps the results already found; changing the filter starts a new search.

### Recording editor runs

Enable **Record local graph executions** in Rivet settings to retain live hosted editor runs in **Run recordings**. Both Browser execution and Studio Server's internal Node executor can capture the parent run and called-project Subgraph runs, including successful runs with no LLM nodes. Server recording policy and retention still apply. Desktop or external Remote Debugger execution does not upload through this hosted-editor feature, and replaying an old recording does not create a new one.

A parent may succeed even if a child fails when the Subgraph's error output handles that failure. Each recording retains its own outcome. An interrupted connection or failed upload may leave a run unavailable; do not assume a completed graph guarantees a retained recording.

### Roots and sub-runs

Selecting the caller workflow also includes related called-project Subgraph recordings, including nested calls. Root runs start folded; expand a root to inspect its indented **Sub-run** cards. Each child has its own replay and delete actions, project and called-graph details, and **Related run key**. Root cards hide that key. Folding or unfolding does not start playback.

In ordinary browsing, pagination and **Bad only** apply to individual recordings. Expand counts say **in current results** because other children can be on another page or excluded by the status filter. If the primary recording is absent from those results, a collapsible context group shows the children without inventing a parent. All linked descendants appear at one indentation level, not a reconstruction of immediate nested call order.

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

When loaded, the border of Rivet will turn yellow, and an "Unload Recording" option will appear in the action bar.

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

To unload the recording and return to normal execution, click the `Unload Recording` button in the action bar.
