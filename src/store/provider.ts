import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { DomainError } from "../domain/errors.js";
import { atomicCreate, atomicWrite } from "./atomic.js";
import { type AgentConfig, type AgentProvider, parseConfig } from "./config.js";
import { configPath } from "./paths.js";

/** Save only this repository's provider choice, retaining comments and CLI overrides. */
export async function saveProvider(
  root: string,
  previous: AgentProvider,
  provider: AgentProvider,
): Promise<AgentConfig> {
  const file = configPath(root);
  let text: string;
  let missing = false;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    text = "version: 1\n";
    missing = true;
  }
  const config = parseConfig(text, file);
  if ((config.agent?.provider ?? "claude") !== previous)
    throw new DomainError(
      "conflict",
      "Provider configuration changed on disk. Reload longe before switching.",
    );
  const doc = parseDocument(text);
  for (const key of ["command", "model", "args"] as const) {
    const legacy = ["agent", key];
    const saved = ["agent", "providers", previous, key];
    if (doc.hasIn(legacy)) {
      if (!doc.hasIn(saved)) doc.setIn(saved, doc.getIn(legacy, true));
      doc.deleteIn(legacy);
    }
  }
  doc.setIn(["agent", "provider"], provider);
  const next = doc.toString();
  const agent = parseConfig(next, file).agent as AgentConfig;
  if (missing) await atomicCreate(file, next);
  else await atomicWrite(file, next);
  return agent;
}
