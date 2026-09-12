# Recordings

Using the `ExecutionRecorder` class in your code, you can generate `.rivet-recording` files that contain
recorded executions of a rivet graph and all its subgraphs.

This documentation is about using `rivet-recording` files to replay your recordings. For information on how to
generate recordings, see the [recording API documentation](../api-reference/recording.md).

## Loading a Recording

### Finding recordings in Rivet Server

Open **Run recordings**, choose a workflow, and use **Filter by input** to search its captured request input with a JSON path such as `$.requestId`. Matching runs appear progressively, newest first. **Stop search** keeps the results already found; changing the filter starts a new search.

Search shows an initial match promptly, then collects larger batches automatically. The ordinary runs-per-page setting does not limit the total search results. Repeated searches can reuse recently extracted inputs, but large histories may exceed the server's memory cache and still require reading recording files again.

**Search complete** means the scan finished. **Search stopped** means the results may be incomplete, including when an unreadable or malformed recording caused an error. Check the displayed error before treating an empty result as proof that no matching run exists.

Deleting a recording temporarily disables row actions in that view until deletion and refresh finish. You can switch workflows or close the modal while it is pending; this does not undo the deletion, and its late response will not replace the new view's results.

### Loading a recording file

Once you have a `rivet-recording` file, you can load it into Rivet using the `Load Recording` option in the action bar dropdown,
or by pressing `Cmd/Ctrl + Shift + O` and selecting the file.

When loaded, the border of Rivet will turn yellow, and an "Unload Recording" option will appear in the action bar.

If `Show node run durations` is enabled in Settings, replayed node outputs show `Duration: ...ms` when the recording contains timing metadata. Older recordings may also show approximate durations derived from their recorded start/finish event timestamps. If the same recorded node has multiple finished runs, including many parallel or sequential runs, Rivet shows the total duration plus one line per run. Turn the setting off to hide these duration lines.

## Saving a Recording

Use **Save Recording** in the action bar to download a recording. When a recording is loaded, Rivet serializes that original recording's execution evidence, even after you play it. Playback is a visual replay of past execution evidence, not a new execution recording, so saving it never replaces the original timeline with the much faster playback delivery timeline.

If no recording is loaded, **Save Recording** downloads the most recent recording captured from a normal local run.

## Playing a Recording

When a recording is loaded, the Play button turns into a "Play Recording" button. Pressing this button will play the recording.

A recording will play back chat-output events from [LLM Chat](../node-reference/llm-chat.mdx) and legacy [Chat](../node-reference/chat.mdx) nodes at a fixed rate. This rate is configurable in the
"General" area of the Rivet settings panel.

Intermediate nodes between chat-output events will be replayed instantly.

Run Activity and the Response inspector show the original recorded timing, not the time required to replay it. If an older or interrupted recording is missing a node's finish/error event—or the overall run has no recorded start—Rivet shows that duration as unavailable instead of guessing from a model call or playback speed.

During playback, you can press the `Pause` button in the action bar to pause the recording where it currently is. Pressing `Resume` will resume the recording from this point.

If a recording is aborted, you can click `Play Recording` again to restart it from the beginning.

To unload the recording and return to normal execution, click the `Unload Recording` button in the action bar.
