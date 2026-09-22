import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { atomicCreate, modifyFile } from "./atomic.js";
import { uniqueQuestionId, uniqueSlug } from "./ids.js";
import { questionPath, questionsDir, stemOf, topicPath, topicsDir } from "./paths.js";
import {
  type NewQuestionInput,
  newQuestionText,
  parseQuestion,
  type Question,
  serializeQuestion,
} from "./question.js";
import {
  type NewTopicInput,
  newTopicText,
  parseTopic,
  serializeTopic,
  type Topic,
} from "./topic.js";

/**
 * File-level access to one repository's `.ai/` folder. Every read hits disk;
 * every write is read–modify–write with atomic replace (§6.2). No caching here —
 * that is the index's job.
 */
export class Repo {
  constructor(public readonly root: string) {}

  async listTopicIds(): Promise<string[]> {
    return listStems(topicsDir(this.root));
  }

  async listQuestionIds(): Promise<string[]> {
    return listStems(questionsDir(this.root));
  }

  async readTopic(id: string): Promise<Topic> {
    const file = topicPath(this.root, id);
    return parseTopic(await readOr404(file, `topic ${id}`), {
      expectedId: id,
      file: relName(file),
    });
  }

  async readQuestion(id: string): Promise<Question> {
    const file = questionPath(this.root, id);
    return parseQuestion(await readOr404(file, `question ${id}`), {
      expectedId: id,
      file: relName(file),
    });
  }

  /** Applies `fn` to a freshly parsed topic and writes it back atomically. */
  async modifyTopic(id: string, fn: (topic: Topic) => void | Promise<void>): Promise<Topic> {
    const file = topicPath(this.root, id);
    let result: Topic | undefined;
    await modifyFile(file, async (text) => {
      const topic = parseTopic(text, { expectedId: id, file: relName(file) });
      await fn(topic);
      result = topic;
      return serializeTopic(topic);
    });
    return result as Topic;
  }

  async modifyQuestion(id: string, fn: (q: Question) => void | Promise<void>): Promise<Question> {
    const file = questionPath(this.root, id);
    let result: Question | undefined;
    await modifyFile(file, async (text) => {
      const q = parseQuestion(text, { expectedId: id, file: relName(file) });
      await fn(q);
      result = q;
      return serializeQuestion(q);
    });
    return result as Question;
  }

  /** Creates a topic file; picks a collision-free slug from `baseSlug`. Returns the id. */
  async createTopic(baseSlug: string, input: Omit<NewTopicInput, "id">): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = uniqueSlug(baseSlug, await this.listTopicIds());
      try {
        await atomicCreate(topicPath(this.root, id), newTopicText({ ...input, id }));
        return id;
      } catch (err) {
        if (!(err instanceof DomainError && err.code === "conflict")) throw err;
      }
    }
    throw new DomainError("conflict", `could not allocate a topic id for ${baseSlug}`);
  }

  /** Creates a question file with a fresh id. Returns the id. */
  async createQuestion(input: Omit<NewQuestionInput, "id">): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = uniqueQuestionId(input.now, await this.listQuestionIds());
      try {
        await atomicCreate(questionPath(this.root, id), newQuestionText({ ...input, id }));
        return id;
      } catch (err) {
        if (!(err instanceof DomainError && err.code === "conflict")) throw err;
      }
    }
    throw new DomainError("conflict", "could not allocate a question id");
  }
}

async function listStems(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names
    .map(stemOf)
    .filter((s): s is string => s !== undefined)
    .sort();
}

async function readOr404(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      throw new DomainError("not_found", `${what} not found`);
    throw err;
  }
}

function relName(file: string): string {
  return path.join(path.basename(path.dirname(file)), path.basename(file));
}
