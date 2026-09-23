import type { AiIndex } from "../index/index.js";
import { type AgentRunner, todoPrompt } from "./agent.js";

/**
 * Todo is the human's queue (§4): whenever the chat is free and no topic is active,
 * it is told to work on the oldest todo topic (the one queued first). A topic is
 * offered once per stay in todo, so an agent that does not pick it up is not asked
 * again in a loop; moving it out of todo and back offers it again.
 */
export function attachTodoQueue(index: AiIndex, agent: AgentRunner): () => void {
  const offered = new Set<string>();
  // say() counts as busy only once its message file is written: bridge that gap
  let waking = false;
  const next = () => {
    const todo = index.topicsByStatus("todo");
    for (const id of offered) if (!todo.some((t) => t.id === id)) offered.delete(id);
    if (waking || agent.busy() || index.topicsByStatus("active").length > 0) return;
    const first = [...todo]
      .filter((t) => !offered.has(t.id))
      .sort((a, b) => a.fm.updated.localeCompare(b.fm.updated))[0];
    if (!first) return;
    offered.add(first.id);
    waking = true;
    void agent
      .say("board", todoPrompt({ id: first.id, title: first.fm.title }))
      .catch(() => {})
      .finally(() => {
        waking = false;
      });
  };
  index.on("batch", next);
  agent.on("agent:idle", next);
  return next;
}
