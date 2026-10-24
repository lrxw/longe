import type { QuestionFrontmatter } from "./types.js";

/**
 * What happened to a question. The inbox emits these after the file is written, both
 * for its own operations (tools, REST, UI) and for changes the file watcher saw (a
 * question file written or answered by hand). Consumers subscribe: notifications, and
 * the board, which moves topics (src/board/question-effects.ts).
 */
export type QuestionEvent =
  | { kind: "asked"; question: QuestionFrontmatter; text: string }
  | { kind: "answered"; question: QuestionFrontmatter; text: string; answer: string }
  | { kind: "withdrawn"; question: QuestionFrontmatter; text: string };

export type QuestionListener = (event: QuestionEvent) => void | Promise<void>;

export class InboxEvents {
  private readonly listeners: QuestionListener[] = [];

  /** Adds a listener; returns a function that removes it again. */
  on(listener: QuestionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * Runs every listener in the order they subscribed and waits for each, so an
   * operation returns only after its consequences (a topic moved, a notification
   * sent). A failing listener is reported and never fails the operation.
   */
  async emit(event: QuestionEvent): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch (err) {
        process.stderr.write(
          `longe: a listener for question ${event.question.id} (${event.kind}) failed: ${String(err)}\n`,
        );
      }
    }
  }
}
