# The inbox diagram

`architecture.svg` is the editable source, embedded in the repository README and the
core-logic guide. It shows the idea behind longe in one view: agents working on
different topics of a project ask with `ask_question`, each question is a file that waits in one inbox,
and your answer goes back to the agent that asked.

For slides, export a PNG from the repository root:

```sh
rsvg-convert --width 2400 --output docs/assets/architecture.png docs/assets/architecture.svg
```
