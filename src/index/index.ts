import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { ParseError } from "../domain/errors.js";
import type { QuestionFrontmatter, QuestionStatus, TopicFrontmatter, TopicStatus } from "../domain/types.js";
import { questionsDir, stemOf, topicsDir } from "../store/paths.js";
import { parseQuestion, questionSections } from "../store/question.js";
import { parseTopic, topicSections } from "../store/topic.js";

export interface IndexedTopic {
  kind: "topic";
  id: string;
  file: string;
  fm: TopicFrontmatter;
  sections: ReturnType<typeof topicSections>;
}

export interface IndexedQuestion {
  kind: "question";
  id: string;
  file: string;
  fm: QuestionFrontmatter;
  sections: ReturnType<typeof questionSections>;
}

export interface IndexedError {
  file: string;
  message: string;
}

export type ChangeType = "added" | "changed" | "removed";

export interface TopicChange {
  id: string;
  type: ChangeType;
  previous?: IndexedTopic | undefined;
  current?: IndexedTopic | undefined;
}
export interface QuestionChange {
  id: string;
  type: ChangeType;
  previous?: IndexedQuestion | undefined;
  current?: IndexedQuestion | undefined;
}

export interface IndexEvents {
  "topic:changed": [TopicChange];
  "question:changed": [QuestionChange];
  "error:changed": [{ file: string; error: IndexedError | undefined }];
  /** Fired once after each debounced batch has been applied. */
  batch: [{ topics: TopicChange[]; questions: QuestionChange[] }];
  ready: [];
}

export interface IndexOptions {
  debounceMs?: number;
  /** Set for tests; chokidar polling is more deterministic on some filesystems. */
  usePolling?: boolean;
}

/**
 * In-memory view of `.ai/topics` and `.ai/questions` kept fresh by chokidar (§6.2).
 * Ids are namespaced by repo root in `key()` so a later multi-repo index can merge (§12).
 */
export class AiIndex extends EventEmitter<IndexEvents> {
  readonly topics = new Map<string, IndexedTopic>();
  readonly questions = new Map<string, IndexedQuestion>();
  readonly errors = new Map<string, IndexedError>();

  private watcher: FSWatcher | undefined;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly usePolling: boolean;

  constructor(public readonly root: string, opts: IndexOptions = {}) {
    super();
    this.debounceMs = opts.debounceMs ?? 100;
    this.usePolling = opts.usePolling ?? false;
  }

  key(id: string): string {
    return `${this.root}::${id}`;
  }

  async start(): Promise<void> {
    const dirs = [topicsDir(this.root), questionsDir(this.root)];
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: false,
      usePolling: this.usePolling,
      interval: 50,
      depth: 0,
      ignored: (p, stats) => !!stats?.isFile() && !p.endsWith(".md"),
    });
    const onFs = (file: string) => this.schedule(file);
    this.watcher.on("add", onFs).on("change", onFs).on("unlink", onFs);
    await new Promise<void>((resolve, reject) => {
      this.watcher?.once("ready", () => resolve());
      this.watcher?.once("error", reject);
    });
    await this.flush();
    this.emit("ready");
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = undefined;
  }

  /** Waits until all currently pending file changes have been applied. */
  async settle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.flush();
    }
    await this.flushing;
  }

  private schedule(file: string): void {
    this.pending.add(file);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.applyPending());
    return this.flushing;
  }

  private async applyPending(): Promise<void> {
    const files = [...this.pending];
    this.pending.clear();
    if (files.length === 0) return;
    const topicChanges: TopicChange[] = [];
    const questionChanges: QuestionChange[] = [];
    for (const file of files) {
      const id = stemOf(file);
      if (!id) continue;
      const dir = path.dirname(file);
      if (dir === topicsDir(this.root)) {
        const c = await this.reindexTopic(id, file);
        if (c) topicChanges.push(c);
      } else if (dir === questionsDir(this.root)) {
        const c = await this.reindexQuestion(id, file);
        if (c) questionChanges.push(c);
      }
    }
    for (const c of topicChanges) this.emit("topic:changed", c);
    for (const c of questionChanges) this.emit("question:changed", c);
    if (topicChanges.length || questionChanges.length) {
      this.emit("batch", { topics: topicChanges, questions: questionChanges });
    }
  }

  private async readOrNull(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private setError(file: string, message: string | undefined): void {
    const rel = path.relative(this.root, file);
    const had = this.errors.get(rel);
    if (message === undefined) {
      if (had) {
        this.errors.delete(rel);
        this.emit("error:changed", { file: rel, error: undefined });
      }
    } else if (had?.message !== message) {
      const error = { file: rel, message };
      this.errors.set(rel, error);
      this.emit("error:changed", { file: rel, error });
    }
  }

  private async reindexTopic(id: string, file: string): Promise<TopicChange | undefined> {
    const previous = this.topics.get(id);
    const text = await this.readOrNull(file);
    if (text === null) {
      this.setError(file, undefined);
      if (!previous) return undefined;
      this.topics.delete(id);
      return { id, type: "removed", previous };
    }
    try {
      const t = parseTopic(text, { expectedId: id, file: path.relative(this.root, file) });
      const current: IndexedTopic = { kind: "topic", id, file, fm: t.fm, sections: topicSections(t) };
      this.topics.set(id, current);
      this.setError(file, undefined);
      return { id, type: previous ? "changed" : "added", previous, current };
    } catch (err) {
      this.setError(file, err instanceof ParseError ? err.message : String(err));
      if (!previous) return undefined;
      this.topics.delete(id);
      return { id, type: "removed", previous };
    }
  }

  private async reindexQuestion(id: string, file: string): Promise<QuestionChange | undefined> {
    const previous = this.questions.get(id);
    const text = await this.readOrNull(file);
    if (text === null) {
      this.setError(file, undefined);
      if (!previous) return undefined;
      this.questions.delete(id);
      return { id, type: "removed", previous };
    }
    try {
      const q = parseQuestion(text, { expectedId: id, file: path.relative(this.root, file) });
      const current: IndexedQuestion = { kind: "question", id, file, fm: q.fm, sections: questionSections(q) };
      this.questions.set(id, current);
      this.setError(file, undefined);
      return { id, type: previous ? "changed" : "added", previous, current };
    } catch (err) {
      this.setError(file, err instanceof ParseError ? err.message : String(err));
      if (!previous) return undefined;
      this.questions.delete(id);
      return { id, type: "removed", previous };
    }
  }

  // ---- derived data -------------------------------------------------------

  questionsForTopic(topicId: string): IndexedQuestion[] {
    return [...this.questions.values()].filter((q) => q.fm.topic === topicId);
  }

  openQuestionCount(topicId: string): number {
    return this.questionsForTopic(topicId).filter((q) => q.fm.status === "open").length;
  }

  openBlockingCount(topicId: string): number {
    return this.questionsForTopic(topicId).filter((q) => q.fm.status === "open" && q.fm.blocking).length;
  }

  /** All open questions: blocking first, then oldest first (§8). */
  inbox(): IndexedQuestion[] {
    return [...this.questions.values()]
      .filter((q) => q.fm.status === "open")
      .sort((a, b) => {
        if (a.fm.blocking !== b.fm.blocking) return a.fm.blocking ? -1 : 1;
        return a.fm.asked_at.localeCompare(b.fm.asked_at) || a.id.localeCompare(b.id);
      });
  }

  /** Number of open blocking questions, project-wide (title badge). */
  blockingCount(): number {
    return [...this.questions.values()].filter((q) => q.fm.status === "open" && q.fm.blocking).length;
  }

  topicsByStatus(status: TopicStatus): IndexedTopic[] {
    return [...this.topics.values()]
      .filter((t) => t.fm.status === status)
      .sort((a, b) => b.fm.updated.localeCompare(a.fm.updated));
  }

  questionsByStatus(status: QuestionStatus): IndexedQuestion[] {
    return [...this.questions.values()].filter((q) => q.fm.status === status);
  }
}
