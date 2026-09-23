import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ParseError } from "../domain/errors.js";
import { formatZodIssues } from "../domain/schemas.js";
import { compactDate, toLocalIso, toLocalIsoMs } from "../domain/time.js";
import { atomicCreate, modifyFile } from "./atomic.js";
import { randomBase36 } from "./ids.js";
import {
  frontmatterObject,
  parseMarkdown,
  sectionText,
  serializeMarkdown,
  setField,
} from "./markdown.js";
import { AI_DIR, stemOf } from "./paths.js";
import { yamlString } from "./topic.js";

/**
 * Chat messages to the agent, one file each under `.ai/messages/`. The chat
 * page is a view over these files plus the live transcript, so the
 * conversation survives a server restart and is committed with the code.
 * Only what the human (or the board on their behalf) says is stored; what the
 * agent has to say goes to the board through the longe tools.
 */
export const messageFrontmatterSchema = z.object({
  id: z.string().regex(/^m-\d{8}-[0-9a-z]{4}$/),
  /** `human`: typed in the chat. `board`: sent by longe, e.g. an answered question. */
  from: z.enum(["human", "board"]),
  at: z.string().min(1),
  /** Topic the message is about (prompt sent from a topic page). */
  topic: z.string().optional(),
  /** When the message reached an agent process. Unset: still waiting. */
  delivered_at: z.string().optional(),
});
export type MessageFrontmatter = z.infer<typeof messageFrontmatterSchema>;

export interface Message {
  fm: MessageFrontmatter;
  text: string;
}

export function messagesDir(root: string): string {
  return path.join(root, AI_DIR, "messages");
}
export function messagePath(root: string, id: string): string {
  return path.join(messagesDir(root), `${id}.md`);
}

export function newMessageId(now: Date): string {
  return `m-${compactDate(now)}-${randomBase36(4)}`;
}

export function parseMessage(text: string, file?: string): Message {
  const doc = parseMarkdown(text, file);
  const parsed = messageFrontmatterSchema.safeParse(frontmatterObject(doc));
  if (!parsed.success) throw new ParseError(formatZodIssues(parsed.error), file);
  return { fm: parsed.data, text: sectionText(doc, "Message").trim() };
}

export interface NewMessageInput {
  from: MessageFrontmatter["from"];
  text: string;
  topic?: string | undefined;
  now: Date;
}

export function newMessageText(id: string, input: NewMessageInput): string {
  const fm = [`id: ${id}`, `from: ${input.from}`, `at: ${toLocalIsoMs(input.now)}`];
  if (input.topic) fm.push(`topic: ${yamlString(input.topic)}`);
  return `---\n${fm.join("\n")}\n---\n## Message\n${input.text.trim()}\n`;
}

/** Writes a new message file; retries the random id on collision. */
export async function writeMessage(root: string, input: NewMessageInput): Promise<Message> {
  await mkdir(messagesDir(root), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = newMessageId(input.now);
    try {
      const text = newMessageText(id, input);
      await atomicCreate(messagePath(root, id), text);
      return parseMessage(text);
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "conflict")) throw err;
    }
  }
  throw new Error("could not generate a unique message id");
}

export async function markDelivered(root: string, id: string, now: Date): Promise<void> {
  await modifyFile(messagePath(root, id), (text) => {
    const doc = parseMarkdown(text);
    setField(doc, "delivered_at", toLocalIso(now));
    return serializeMarkdown(doc);
  });
}

/**
 * Deletes delivered message files (and broken ones). Messages still waiting for
 * delivery stay, so clearing the history never loses what the agent has not seen.
 * Returns how many files were removed.
 */
export async function clearMessages(root: string): Promise<number> {
  let files: string[];
  try {
    files = await readdir(messagesDir(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let n = 0;
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const file = path.join(messagesDir(root), f);
    let waiting = false;
    try {
      waiting = parseMessage(await readFile(file, "utf8"), f).fm.delivered_at === undefined;
    } catch {
      // broken: nothing to deliver, remove it
    }
    if (waiting) continue;
    await unlink(file);
    n++;
  }
  return n;
}

/** All messages, oldest first. Unparseable files are skipped, not fatal. */
export async function listMessages(root: string): Promise<Message[]> {
  let files: string[];
  try {
    files = await readdir(messagesDir(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: Message[] = [];
  for (const f of files) {
    const id = stemOf(f);
    if (!id) continue;
    try {
      const m = parseMessage(await readFile(messagePath(root, id), "utf8"), f);
      if (m.fm.id === id) out.push(m);
    } catch {
      // a broken message file must not take the chat page down
    }
  }
  return out.sort((a, b) => a.fm.at.localeCompare(b.fm.at) || a.fm.id.localeCompare(b.fm.id));
}
