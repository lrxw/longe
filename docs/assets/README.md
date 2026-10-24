# The longe ask / longe board diagram

`architecture.svg` is the editable source, embedded in the repository README and the
core-logic guide. It shows longe board's managed chat and standalone longe ask clients
sharing question files and the same Inbox. Topic-linked questions drive board transitions;
questions about other subjects do not need the topic workflow. The bottom panel distinguishes
managed-chat answer delivery from explicit waiting or checking by external clients.

The [core-logic guide](../core-logic.md#module-boundary-and-event-flow) contains a technical
Mermaid diagram of the module boundary, file watcher, event listeners and chat queue.

For slides, export a PNG from the repository root:

```sh
rsvg-convert --width 2400 --output docs/assets/architecture.png docs/assets/architecture.svg
```
